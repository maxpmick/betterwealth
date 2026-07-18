import type { ApiTransaction, CursorPage } from "../../api";
import { transactions as fixtureTransactions } from "../../data";
import { formatMoneyExact, minorToMajor } from "../../lib/money";
import type { LedgerRangeFilters, TransactionView } from "./types";

export function readableDate(value: string, fallbackIndex: number) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallbackIndex < 2 ? "Today" : "Earlier";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: parsed.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  }).format(parsed);
}

export function displayItems(page: CursorPage<ApiTransaction>): TransactionView[] {
  return page.data.map((item, index) => {
    const fallback = fixtureTransactions.find((candidate) => candidate.id === item.id);
    return {
      id: item.id,
      accountId: item.accountId,
      effectiveDate: item.effectiveDate,
      date: fallback?.date ?? readableDate(item.effectiveDate, index),
      merchant: item.merchant,
      rawDescription: item.description,
      account: item.accountName,
      accountMask: fallback?.accountMask ?? "••••",
      category: item.categoryName,
      envelope: item.envelopeName ?? "Unassigned",
      amount: minorToMajor(item.amount.minorUnits, item.amount.currency),
      amountMinorUnits: item.amount.minorUnits,
      currency: item.amount.currency,
      status: item.status,
      source: item.source,
      tags: item.tags,
      pending: item.status === "pending",
      needsReview: item.reviewState === "needs_review",
      recurring: item.isRecurring ?? false,
      excluded: item.isExcluded ?? fallback?.excluded ?? false,
      isTransfer: item.isTransfer ?? false,
      isIncome: item.isIncome ?? false,
      hasSplits: item.hasSplits ?? false,
      ...(item.transferId ? { transferId: item.transferId } : {}),
      refundLinkIds: item.refundLinkIds ?? [],
      ...(item.transfer ? { transferMatch: item.transfer } : {}),
      refundLinkMatches: item.refundLinks ?? [],
      note: item.note ?? "",
      provenance:
        item.provenance ??
        (item.source === "simplefin"
          ? "SimpleFIN provider import"
          : item.source === "import"
            ? "Reviewed file import"
            : "Manual entry"),
    };
  });
}

export function formatMinorUnits(minorUnits: bigint, currency: string) {
  return formatMoneyExact(minorUnits, currency);
}

export function minorUnitsToInput(minorUnits: bigint) {
  const absolute = minorUnits < 0n ? -minorUnits : minorUnits;
  return `${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

export function parsePositiveCurrencyMinorUnits(value: string): bigint | null {
  const normalized = value.trim().replace(/[$,]/g, "");
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null;
  const [whole = "0", fraction = ""] = normalized.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return amount > 0n ? amount : null;
}

export function directionLabel(item: TransactionView) {
  return BigInt(item.amountMinorUnits) < 0n ? "outflow" : "credit";
}

export function candidateLabel(item: TransactionView) {
  return `${item.merchant} · ${item.account} · ${formatMinorUnits(BigInt(item.amountMinorUnits), item.currency)}`;
}

export function hasSuggestedMatch(item: TransactionView) {
  return (
    item.transferMatch?.status === "suggested" ||
    item.refundLinkMatches.some(({ status }) => status === "suggested")
  );
}

export function matchesTransactionFilters(
  item: TransactionView,
  options: {
    query: string;
    tab: string;
    filters: string[];
    range: LedgerRangeFilters;
  },
) {
  const { query, tab, filters, range } = options;
  const matchesSearch =
    `${item.merchant} ${item.rawDescription} ${item.category} ${item.account} ${item.note ?? ""} ${item.amount} ${formatMinorUnits(BigInt(item.amountMinorUnits), item.currency)}`
      .toLowerCase()
      .includes(query.toLowerCase());
  const matchesTab =
    (tab === "all" && item.status !== "removed") ||
    (tab === "review" &&
      item.status !== "removed" &&
      (item.needsReview || hasSuggestedMatch(item))) ||
    (tab === "removed" && item.status === "removed");
  const absoluteAmount = Math.abs(Number(item.amountMinorUnits)) / 100;
  const minimum = Number(range.minimum);
  const maximum = Number(range.maximum);
  const effectiveDay = item.effectiveDate.slice(0, 10);
  const matchesRange =
    (!range.minimum || absoluteAmount >= minimum) &&
    (!range.maximum || absoluteAmount <= maximum) &&
    (!range.fromDate || effectiveDay >= range.fromDate) &&
    (!range.toDate || effectiveDay <= range.toDate);
  const selectedStatuses = filters.filter((filter) =>
    ["Needs review", "Suggested match", "Pending", "Posted", "Removed", "Excluded"].includes(
      filter,
    ),
  );
  const selectedTypes = filters.filter((filter) =>
    ["Income", "Expense", "Transfer", "Refund", "Recurring"].includes(filter),
  );
  const selectedSources = filters.filter((filter) =>
    ["SimpleFIN", "Manual", "CSV import"].includes(filter),
  );
  const matchesStatus =
    !selectedStatuses.length ||
    selectedStatuses.some(
      (filter) =>
        (filter === "Needs review" && item.needsReview) ||
        (filter === "Suggested match" && hasSuggestedMatch(item)) ||
        (filter === "Pending" && item.status === "pending") ||
        (filter === "Posted" && item.status === "posted") ||
        (filter === "Removed" && item.status === "removed") ||
        (filter === "Excluded" && Boolean(item.excluded)),
    );
  const matchesType =
    !selectedTypes.length ||
    selectedTypes.some(
      (filter) =>
        (filter === "Income" && item.isIncome) ||
        (filter === "Expense" && BigInt(item.amountMinorUnits) < 0n && !item.isTransfer) ||
        (filter === "Transfer" && item.isTransfer) ||
        (filter === "Refund" && item.refundLinkIds.length > 0) ||
        (filter === "Recurring" && Boolean(item.recurring)),
    );
  const matchesSource =
    !selectedSources.length ||
    selectedSources.some(
      (filter) =>
        (filter === "SimpleFIN" && item.source === "simplefin") ||
        (filter === "Manual" && item.source === "manual") ||
        (filter === "CSV import" && item.source === "import"),
    );
  return (
    matchesSearch && matchesTab && matchesStatus && matchesType && matchesSource && matchesRange
  );
}

export function localDateTimeValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function estimatedImportRecords(filename: string, content: string) {
  if (filename.toLowerCase().endsWith(".csv")) {
    return Math.max(0, content.split(/\r?\n/).filter((line) => line.trim()).length - 1);
  }
  return content.match(/<STMTTRN>/gi)?.length ?? 0;
}
