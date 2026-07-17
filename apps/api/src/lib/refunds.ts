import type { BetterWealthDatabase } from "@betterwealth/db";
import { refundLinks } from "@betterwealth/db/schema";
import { and, eq, inArray } from "drizzle-orm";

export async function confirmedRefundAmounts(
  db: BetterWealthDatabase,
  householdId: string,
  transactionIds: readonly string[],
) {
  const uniqueIds = [...new Set(transactionIds)];
  const result = new Map<string, bigint>();
  if (uniqueIds.length === 0) return result;
  const rows = await db
    .select({ transactionId: refundLinks.refundTransactionId, amount: refundLinks.amount })
    .from(refundLinks)
    .where(
      and(
        eq(refundLinks.householdId, householdId),
        eq(refundLinks.status, "confirmed"),
        inArray(refundLinks.refundTransactionId, uniqueIds),
      ),
    );
  for (const row of rows) {
    result.set(row.transactionId, (result.get(row.transactionId) ?? 0n) + row.amount);
  }
  return result;
}

export function cappedConfirmedRefund(transactionAmount: bigint, linkedAmount: bigint | undefined) {
  if (transactionAmount <= 0n || !linkedAmount || linkedAmount <= 0n) return 0n;
  return linkedAmount < transactionAmount ? linkedAmount : transactionAmount;
}
