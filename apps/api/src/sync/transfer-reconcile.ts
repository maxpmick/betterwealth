import type { BetterWealthDatabase } from "@betterwealth/db";
import { transactions, transfers } from "@betterwealth/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { ulid } from "ulid";

type Candidate = {
  id: string;
  accountId: string;
  amount: bigint;
  currency: string;
  transactedOn: string;
  description: string;
  providerMetadata: unknown;
};

function providerPairKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const key = (value as Record<string, unknown>).transfer_pair;
  return typeof key === "string" && key.trim() ? key.trim().slice(0, 200) : undefined;
}

function transferLike(description: string): boolean {
  return /\b(transfer|xfer|internal)\b|credit.?card payment|loan payment/i.test(description);
}

function daysApart(left: string, right: string): number {
  const leftTime = new Date(`${left.slice(0, 10)}T12:00:00.000Z`).getTime();
  const rightTime = new Date(`${right.slice(0, 10)}T12:00:00.000Z`).getTime();
  return Math.abs(leftTime - rightTime) / 86_400_000;
}

async function persistMatch(
  db: BetterWealthDatabase,
  householdId: string,
  outflow: Candidate,
  inflow: Candidate,
  matchedBy: "provider" | "fingerprint",
  confidenceBps: number,
) {
  const inserted = await db
    .insert(transfers)
    .values({
      id: ulid(),
      householdId,
      outflowTransactionId: outflow.id,
      inflowTransactionId: inflow.id,
      confidenceBps,
      status: "confirmed",
      matchedBy,
    })
    .onConflictDoNothing()
    .returning({ id: transfers.id });
  if (inserted.length === 0) return false;
  await db
    .update(transactions)
    .set({ isTransfer: true, reviewState: "none", updatedAt: new Date().toISOString() })
    .where(and(eq(transactions.householdId, householdId), eq(transactions.id, outflow.id)));
  await db
    .update(transactions)
    .set({ isTransfer: true, reviewState: "none", updatedAt: new Date().toISOString() })
    .where(and(eq(transactions.householdId, householdId), eq(transactions.id, inflow.id)));
  return true;
}

/**
 * Confirm only exact, owned-account pairs. Provider pair IDs win; the fallback requires a unique
 * opposite amount, matching currency, a short date window, and transfer-like text.
 */
export async function reconcileAccountTransfers(db: BetterWealthDatabase, householdId: string) {
  const rows: Candidate[] = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amount: transactions.amount,
      currency: transactions.currency,
      transactedOn: transactions.transactedOn,
      description: transactions.normalizedDescription,
      providerMetadata: transactions.providerMetadata,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.householdId, householdId),
        eq(transactions.status, "posted"),
        eq(transactions.isTransfer, false),
      ),
    )
    .orderBy(asc(transactions.transactedOn))
    .limit(2_000);
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
      outflow.amount + inflow.amount !== 0n
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
  for (const outflow of outflows) {
    for (const inflow of inflows) {
      if (
        outflow.accountId === inflow.accountId ||
        outflow.currency !== inflow.currency ||
        outflow.amount + inflow.amount !== 0n ||
        daysApart(outflow.transactedOn, inflow.transactedOn) > 3 ||
        (!transferLike(outflow.description) && !transferLike(inflow.description))
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
