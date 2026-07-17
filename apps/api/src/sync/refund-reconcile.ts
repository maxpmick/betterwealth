import type { BetterWealthDatabase } from "@betterwealth/db";
import { accounts, refundLinks, transactions } from "@betterwealth/db/schema";
import { and, desc, eq, inArray, isNotNull, lt, ne, notInArray, or } from "drizzle-orm";
import { ulid } from "ulid";

const RECONCILIATION_PAGE_SIZE = 500;
const MAX_REFUND_AGE_DAYS = 90;

type Candidate = {
  id: string;
  accountId: string;
  merchantId: string;
  amount: bigint;
  currency: string;
  transactedOn: string;
};

function dateNumber(value: string) {
  return Math.floor(new Date(`${value.slice(0, 10)}T12:00:00.000Z`).getTime() / 86_400_000);
}

function candidateKey(candidate: Candidate) {
  const absoluteAmount = candidate.amount < 0n ? -candidate.amount : candidate.amount;
  return [candidate.accountId, candidate.merchantId, candidate.currency, absoluteAmount].join(
    "\u001f",
  );
}

function isValidSuggestedPair(refund: Candidate | undefined, purchase: Candidate | undefined) {
  if (!refund || !purchase || refund.amount <= 0n || purchase.amount >= 0n) return false;
  if (candidateKey(refund) !== candidateKey(purchase)) return false;
  const refundDate = dateNumber(refund.transactedOn);
  const purchaseDate = dateNumber(purchase.transactedOn);
  return purchaseDate <= refundDate && refundDate - purchaseDate <= MAX_REFUND_AGE_DAYS;
}

async function persistSuggestion(
  db: BetterWealthDatabase,
  householdId: string,
  refund: Candidate,
  purchase: Candidate,
) {
  return db.transaction((transaction) => {
    const occupied = transaction
      .select({ id: refundLinks.id })
      .from(refundLinks)
      .where(
        and(
          eq(refundLinks.householdId, householdId),
          ne(refundLinks.status, "rejected"),
          or(
            eq(refundLinks.refundTransactionId, refund.id),
            eq(refundLinks.purchaseTransactionId, purchase.id),
          ),
        ),
      )
      .get();
    if (occupied) return false;

    const inserted = transaction
      .insert(refundLinks)
      .values({
        id: ulid(),
        householdId,
        refundTransactionId: refund.id,
        purchaseTransactionId: purchase.id,
        amount: refund.amount,
        confidenceBps: 9_900,
        status: "suggested",
      })
      .onConflictDoNothing()
      .returning({ id: refundLinks.id })
      .all();
    return inserted.length > 0;
  });
}

/**
 * Suggest exact refunds without changing categorization or reporting flags. A candidate must be an
 * exact opposite amount in the same currency, account, and normalized merchant, with the purchase
 * no more than 90 days before the credit. Ambiguous matches stay in review instead of being guessed.
 */
export async function reconcileAccountRefunds(db: BetterWealthDatabase, householdId: string) {
  const relationships = await db
    .select({
      id: refundLinks.id,
      refundTransactionId: refundLinks.refundTransactionId,
      purchaseTransactionId: refundLinks.purchaseTransactionId,
      amount: refundLinks.amount,
      status: refundLinks.status,
    })
    .from(refundLinks)
    .where(eq(refundLinks.householdId, householdId));
  const candidates: Candidate[] = [];
  let cursor: { transactedOn: string; id: string } | undefined;
  while (true) {
    const page = await db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        merchantId: transactions.merchantId,
        amount: transactions.amount,
        currency: transactions.currency,
        transactedOn: transactions.transactedOn,
      })
      .from(transactions)
      .innerJoin(
        accounts,
        and(
          eq(accounts.householdId, transactions.householdId),
          eq(accounts.id, transactions.accountId),
        ),
      )
      .where(
        and(
          eq(transactions.householdId, householdId),
          eq(transactions.status, "posted"),
          eq(transactions.isTransfer, false),
          isNotNull(transactions.merchantId),
          notInArray(accounts.group, ["investment", "crypto", "rewards"]),
          cursor
            ? or(
                lt(transactions.transactedOn, cursor.transactedOn),
                and(
                  eq(transactions.transactedOn, cursor.transactedOn),
                  lt(transactions.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(transactions.transactedOn), desc(transactions.id))
      .limit(RECONCILIATION_PAGE_SIZE);
    candidates.push(
      ...page.flatMap((candidate) =>
        candidate.merchantId && candidate.amount !== 0n
          ? [{ ...candidate, merchantId: candidate.merchantId }]
          : [],
      ),
    );
    if (page.length < RECONCILIATION_PAGE_SIZE) break;
    const last = page.at(-1)!;
    cursor = { transactedOn: last.transactedOn, id: last.id };
  }

  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const invalidSuggestionIds = relationships
    .filter(({ status }) => status === "suggested")
    .filter(({ refundTransactionId, purchaseTransactionId, amount }) => {
      const refund = candidateById.get(refundTransactionId);
      const purchase = candidateById.get(purchaseTransactionId);
      return !isValidSuggestedPair(refund, purchase) || refund?.amount !== amount;
    })
    .map(({ id }) => id);
  for (let index = 0; index < invalidSuggestionIds.length; index += 400) {
    await db
      .delete(refundLinks)
      .where(
        and(
          eq(refundLinks.householdId, householdId),
          eq(refundLinks.status, "suggested"),
          inArray(refundLinks.id, invalidSuggestionIds.slice(index, index + 400)),
        ),
      );
  }
  const invalidSuggestionIdSet = new Set(invalidSuggestionIds);
  const occupiedIds = new Set(
    relationships
      .filter(({ id, status }) => status !== "rejected" && !invalidSuggestionIdSet.has(id))
      .flatMap(({ refundTransactionId, purchaseTransactionId }) => [
        refundTransactionId,
        purchaseTransactionId,
      ]),
  );

  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (occupiedIds.has(candidate.id)) continue;
    const key = candidateKey(candidate);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }

  const uniquePurchaseByRefund = new Map<string, Candidate>();
  const refundsByPurchase = new Map<string, Candidate[]>();
  for (const group of groups.values()) {
    const purchases = group.filter(({ amount }) => amount < 0n);
    const refunds = group.filter(({ amount }) => amount > 0n);
    for (const refund of refunds) {
      const refundDate = dateNumber(refund.transactedOn);
      const possiblePurchases = purchases.filter((purchase) => {
        const purchaseDate = dateNumber(purchase.transactedOn);
        return purchaseDate <= refundDate && refundDate - purchaseDate <= MAX_REFUND_AGE_DAYS;
      });
      if (possiblePurchases.length !== 1) continue;
      const purchase = possiblePurchases[0]!;
      uniquePurchaseByRefund.set(refund.id, purchase);
      refundsByPurchase.set(purchase.id, [...(refundsByPurchase.get(purchase.id) ?? []), refund]);
    }
  }

  let matched = 0;
  const orderedRefunds = candidates
    .filter(({ amount }) => amount > 0n)
    .sort((left, right) =>
      left.transactedOn === right.transactedOn
        ? left.id.localeCompare(right.id)
        : left.transactedOn.localeCompare(right.transactedOn),
    );
  for (const refund of orderedRefunds) {
    const purchase = uniquePurchaseByRefund.get(refund.id);
    if (!purchase || (refundsByPurchase.get(purchase.id) ?? []).length !== 1) continue;
    if (await persistSuggestion(db, householdId, refund, purchase)) matched += 1;
  }
  return { matched };
}
