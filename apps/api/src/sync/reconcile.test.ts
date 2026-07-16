import { describe, expect, test } from "bun:test";
import {
  normalizeDescription,
  reconcilePendingTransactions,
  transactionFingerprint,
} from "./reconcile";

const base = {
  accountId: "checking",
  amountMinor: "-4250",
  description: "PENDING VISA COFFEE SHOP 123456",
  occurredAt: "2026-07-12T12:00:00.000Z",
  pending: true,
};

describe("pending reconciliation", () => {
  test("normalizes noisy merchant descriptions", () => {
    expect(normalizeDescription(base.description)).toBe("COFFEE SHOP");
  });

  test("fingerprints deterministically", () => {
    const input = { ...base };
    expect(transactionFingerprint(input)).toBe(transactionFingerprint(input));
  });

  test("merges a unique changed-ID posting", () => {
    const result = reconcilePendingTransactions(
      [{ ...base, id: "pending-1", externalId: "old" }],
      [
        {
          ...base,
          id: "posted-1",
          externalId: "new",
          pending: false,
          description: "COFFEE SHOP",
          occurredAt: "2026-07-14T12:00:00.000Z",
        },
      ],
    );
    expect(result.matches).toEqual([
      { pendingId: "pending-1", postedId: "posted-1", reason: "fingerprint" },
    ]);
  });

  test("never silently merges an ambiguous same-amount transaction", () => {
    const result = reconcilePendingTransactions(
      [
        { ...base, id: "pending-1" },
        { ...base, id: "pending-2", occurredAt: "2026-07-13T12:00:00.000Z" },
      ],
      [{ ...base, id: "posted-1", pending: false, description: "COFFEE SHOP" }],
    );
    expect(result.matches).toHaveLength(0);
    expect(result.ambiguousPostedIds).toEqual(["posted-1"]);
  });
});
