import { createHash } from "node:crypto";

export type PendingCandidate = {
  id: string;
  accountId: string;
  externalId?: string;
  amountMinor: string;
  description: string;
  occurredAt: string;
  pending: boolean;
};

export function normalizeDescription(description: string): string {
  return description
    .normalize("NFKC")
    .toUpperCase()
    .replace(/\b(?:PENDING|POS|DEBIT|PURCHASE|CHECKCARD|VISA|MC)\b/g, " ")
    .replace(/\b\d{4,}\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function transactionFingerprint(
  transaction: Omit<PendingCandidate, "id" | "pending">,
): string {
  const day = transaction.occurredAt.slice(0, 10);
  return createHash("sha256")
    .update(
      [
        transaction.accountId,
        transaction.amountMinor,
        normalizeDescription(transaction.description),
        day,
      ].join("\u001f"),
    )
    .digest("hex");
}

function dayDistance(left: string, right: string): number {
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  return Math.abs(leftTime - rightTime) / 86_400_000;
}

function descriptionsAreCompatible(left: string, right: string): boolean {
  const normalizedLeft = normalizeDescription(left);
  const normalizedRight = normalizeDescription(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  );
}

export function reconcilePendingTransactions(
  existingPending: readonly PendingCandidate[],
  incomingPosted: readonly PendingCandidate[],
  maximumDays = 7,
): {
  matches: Array<{ pendingId: string; postedId: string; reason: "external_id" | "fingerprint" }>;
  ambiguousPostedIds: string[];
  unmatchedPostedIds: string[];
} {
  const matches: Array<{
    pendingId: string;
    postedId: string;
    reason: "external_id" | "fingerprint";
  }> = [];
  const ambiguousPostedIds: string[] = [];
  const unmatchedPostedIds: string[] = [];
  const usedPending = new Set<string>();

  for (const posted of incomingPosted) {
    const exact = posted.externalId
      ? existingPending.filter(
          (pending) =>
            !usedPending.has(pending.id) &&
            pending.accountId === posted.accountId &&
            pending.externalId === posted.externalId,
        )
      : [];
    if (exact.length === 1 && exact[0]) {
      usedPending.add(exact[0].id);
      matches.push({ pendingId: exact[0].id, postedId: posted.id, reason: "external_id" });
      continue;
    }

    const candidates = existingPending.filter(
      (pending) =>
        !usedPending.has(pending.id) &&
        pending.accountId === posted.accountId &&
        pending.amountMinor === posted.amountMinor &&
        dayDistance(pending.occurredAt, posted.occurredAt) <= maximumDays &&
        descriptionsAreCompatible(pending.description, posted.description),
    );
    if (candidates.length === 1 && candidates[0]) {
      usedPending.add(candidates[0].id);
      matches.push({ pendingId: candidates[0].id, postedId: posted.id, reason: "fingerprint" });
    } else if (candidates.length > 1) ambiguousPostedIds.push(posted.id);
    else unmatchedPostedIds.push(posted.id);
  }

  return { matches, ambiguousPostedIds, unmatchedPostedIds };
}
