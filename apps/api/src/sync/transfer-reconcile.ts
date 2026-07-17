import type { BetterWealthDatabase } from "@betterwealth/db";
import { transactions, transfers } from "@betterwealth/db/schema";
import { and, desc, eq, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { ulid } from "ulid";

const RECONCILIATION_PAGE_SIZE = 500;

type Candidate = {
  id: string;
  accountId: string;
  amount: bigint;
  currency: string;
  transactedOn: string;
  providerMetadata: unknown;
};

function providerPairKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const key = (value as Record<string, unknown>).transfer_pair;
  return typeof key === "string" && key.trim() ? key.trim().slice(0, 200) : undefined;
}

function daysApart(left: string, right: string): number {
  const leftTime = new Date(`${left.slice(0, 10)}T12:00:00.000Z`).getTime();
  const rightTime = new Date(`${right.slice(0, 10)}T12:00:00.000Z`).getTime();
  return Math.abs(leftTime - rightTime) / 86_400_000;
}

function pairKey(outflowTransactionId: string, inflowTransactionId: string) {
  return `${outflowTransactionId}\u001f${inflowTransactionId}`;
}

async function persistMatch(
  db: BetterWealthDatabase,
  householdId: string,
  outflow: Candidate,
  inflow: Candidate,
  matchedBy: "provider" | "fingerprint",
  confidenceBps: number,
) {
  return db.transaction((transaction) => {
    const transactionIds = [outflow.id, inflow.id];
    const existing = transaction
      .select({ id: transfers.id })
      .from(transfers)
      .where(
        and(
          eq(transfers.householdId, householdId),
          ne(transfers.status, "rejected"),
          or(
            inArray(transfers.outflowTransactionId, transactionIds),
            inArray(transfers.inflowTransactionId, transactionIds),
          ),
        ),
      )
      .get();
    if (existing) return false;
    const inserted = transaction
      .insert(transfers)
      .values({
        id: ulid(),
        householdId,
        outflowTransactionId: outflow.id,
        inflowTransactionId: inflow.id,
        confidenceBps,
        status: "suggested",
        matchedBy,
      })
      .onConflictDoNothing()
      .returning({ id: transfers.id })
      .all();
    return inserted.length > 0;
  });
}

/**
 * Suggest only exact, owned-account pairs. Provider pair IDs win; the fallback requires a unique
 * opposite amount, matching currency, and a short date window. Suggestions do not affect reporting
 * until a user confirms them through the ledger API.
 */
export async function reconcileAccountTransfers(db: BetterWealthDatabase, householdId: string) {
  const existingRelationships = await db
    .select({
      outflowTransactionId: transfers.outflowTransactionId,
      inflowTransactionId: transfers.inflowTransactionId,
      status: transfers.status,
    })
    .from(transfers)
    .where(eq(transfers.householdId, householdId));
  const occupiedTransactionIds = new Set(
    existingRelationships
      .filter(({ status }) => status !== "rejected")
      .flatMap(({ outflowTransactionId, inflowTransactionId }) => [
        outflowTransactionId,
        inflowTransactionId,
      ]),
  );
  const rejectedPairs = new Set(
    existingRelationships
      .filter(({ status }) => status === "rejected")
      .map(({ outflowTransactionId, inflowTransactionId }) =>
        pairKey(outflowTransactionId, inflowTransactionId),
      ),
  );
  const rows: Candidate[] = [];
  let cursor: { transactedOn: string; id: string } | undefined;
  while (true) {
    const page: Candidate[] = await db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        amount: transactions.amount,
        currency: transactions.currency,
        transactedOn: transactions.transactedOn,
        providerMetadata: transactions.providerMetadata,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.householdId, householdId),
          eq(transactions.status, "posted"),
          eq(transactions.isTransfer, false),
          eq(transactions.isExcluded, false),
          isNull(transactions.userOverrideAt),
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
    rows.push(...page.filter(({ id }) => !occupiedTransactionIds.has(id)));
    if (page.length < RECONCILIATION_PAGE_SIZE) break;
    const last = page.at(-1)!;
    cursor = { transactedOn: last.transactedOn, id: last.id };
  }
  const used = new Set<string>();
  let matched = 0;

  const providerGroups = new Map<string, Candidate[]>();
  for (const row of rows) {
    const key = providerPairKey(row.providerMetadata);
    if (!key) continue;
    const group = providerGroups.get(key) ?? [];
    group.push(row);
    providerGroups.set(key, group);
  }
  for (const group of providerGroups.values()) {
    if (group.length !== 2) continue;
    const outflow = group.find(({ amount }) => amount < 0n);
    const inflow = group.find(({ amount }) => amount > 0n);
    if (
      !outflow ||
      !inflow ||
      outflow.accountId === inflow.accountId ||
      outflow.currency !== inflow.currency ||
      outflow.amount + inflow.amount !== 0n ||
      rejectedPairs.has(pairKey(outflow.id, inflow.id))
    ) {
      continue;
    }
    if (await persistMatch(db, householdId, outflow, inflow, "provider", 10_000)) {
      used.add(outflow.id);
      used.add(inflow.id);
      matched += 1;
    }
  }

  const outflows = rows.filter(({ id, amount }) => amount < 0n && !used.has(id));
  const inflows = rows.filter(({ id, amount }) => amount > 0n && !used.has(id));
  const candidatesForOutflow = new Map<string, Candidate[]>();
  const candidatesForInflow = new Map<string, Candidate[]>();
  const inflowsByAmount = new Map<string, Candidate[]>();
  for (const inflow of inflows) {
    const key = `${inflow.currency}\u001f${inflow.amount.toString()}`;
    inflowsByAmount.set(key, [...(inflowsByAmount.get(key) ?? []), inflow]);
  }
  for (const outflow of outflows) {
    const amountKey = `${outflow.currency}\u001f${(-outflow.amount).toString()}`;
    for (const inflow of inflowsByAmount.get(amountKey) ?? []) {
      if (
        outflow.accountId === inflow.accountId ||
        daysApart(outflow.transactedOn, inflow.transactedOn) > 3 ||
        rejectedPairs.has(pairKey(outflow.id, inflow.id))
      ) {
        continue;
      }
      candidatesForOutflow.set(outflow.id, [
        ...(candidatesForOutflow.get(outflow.id) ?? []),
        inflow,
      ]);
      candidatesForInflow.set(inflow.id, [...(candidatesForInflow.get(inflow.id) ?? []), outflow]);
    }
  }
  for (const outflow of outflows) {
    const options = candidatesForOutflow.get(outflow.id) ?? [];
    if (options.length !== 1) continue;
    const inflow = options[0]!;
    if ((candidatesForInflow.get(inflow.id) ?? []).length !== 1) continue;
    if (used.has(outflow.id) || used.has(inflow.id)) continue;
    if (await persistMatch(db, householdId, outflow, inflow, "fingerprint", 9_800)) {
      used.add(outflow.id);
      used.add(inflow.id);
      matched += 1;
    }
  }
  return { matched };
}
