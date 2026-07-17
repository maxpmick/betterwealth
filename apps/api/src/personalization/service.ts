import { createHash, randomUUID } from "node:crypto";
import type { BetterWealthDatabase } from "@betterwealth/db";
import {
  accounts,
  aiSuggestions,
  assets,
  assetValuations,
  auditEvents,
  balanceSnapshots,
  bills,
  budgetPeriods,
  categories,
  envelopeAllocations,
  envelopeCategoryLinks,
  envelopeRuleLinks,
  envelopes,
  goals,
  householdMembers,
  households,
  incomeSources,
  merchants,
  payCycles,
  recurringSeries,
  refundLinks,
  rules,
  settings,
  transactionSplits,
  transactions,
  transfers,
  users,
} from "@betterwealth/db/schema";
import {
  divideAndRound,
  type RuleAction,
  RuleActionSchema,
  type RuleCondition,
  ruleSpecificity,
} from "@betterwealth/shared";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  like,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { categorizeHouseholdTransactions } from "../categorization/service";
import type { AppConfig } from "../config";
import {
  isRetirementAccount,
  liquidAccountContribution,
  liquidAssetContribution,
} from "../lib/net-worth";
import { normalizeDescription } from "../sync/reconcile";

const DAY_MS = 86_400_000;
const PLAN_VERSION = "betterwealth-personalization-v1";
const STARTER_LIQUID_TARGET = 25_000_000n;
const STARTER_BUFFER_FLOOR = 100_000n;
const TRUSTED_PATTERN_COVERAGE_BPS = 6_000;
const TRUSTED_PATTERN_AGREEMENT_BPS = 8_000;
const GENERATED_RULE_PRIORITY = 50;
const REFUND_EXCLUDED_ACCOUNT_GROUPS = new Set(["investment", "crypto", "rewards"]);

type CategoryKind = "income" | "expense" | "transfer" | "debt" | "investment";
type Direction = "inflow" | "outflow";
type CategoryOrigin = "user" | "rule" | "provider" | "merchant_history" | "ai" | "none";

export const PERSONALIZATION_CATEGORY_BLUEPRINT = [
  ["paycheck", "Paycheck", "income", "payments", "#16815F"],
  ["other-income", "Other income", "income", "add_card", "#2D9874"],
  ["rent-mortgage", "Rent & mortgage", "housing", "apartment", "#3C6FB6"],
  ["home-services", "Home services", "housing", "home_repair_service", "#5D8BCB"],
  ["groceries", "Groceries", "food", "shopping_cart", "#D68625"],
  ["dining-coffee", "Dining & coffee", "food", "restaurant", "#C76C45"],
  ["gas", "Gas", "transportation", "local_gas_station", "#7253AA"],
  ["auto-maintenance", "Auto maintenance", "transportation", "car_repair", "#8265B9"],
  ["transit-rides", "Transit & rides", "transportation", "train", "#9278C2"],
  ["phone-internet", "Phone & internet", "utilities", "wifi", "#387789"],
  ["home-utilities", "Home utilities", "utilities", "bolt", "#4E8B9C"],
  ["insurance", "Insurance", "personal", "verified_user", "#8B5E7C"],
  ["medical", "Medical", "health", "medical_services", "#CF5049"],
  ["fitness", "Fitness", "health", "fitness_center", "#DE716B"],
  ["shopping", "Shopping", "personal", "shopping_bag", "#9B5D83"],
  ["personal-care", "Personal care", "personal", "self_improvement", "#AD7897"],
  ["subscriptions", "Subscriptions", "fun", "subscriptions", "#7A593A"],
  ["entertainment", "Entertainment", "fun", "theaters", "#906F4D"],
  ["travel", "Travel", "fun", "flight", "#A58562"],
  ["gifts-giving", "Gifts & giving", "personal", "redeem", "#B07A95"],
  ["education", "Education", "personal", "school", "#765D91"],
  ["loan-payments", "Loan payments", "debt", "credit_score", "#BA5C3F"],
  ["brokerage-contributions", "Brokerage contributions", "investing", "trending_up", "#20735F"],
] as const satisfies readonly (readonly [string, string, string, string, string])[];

const ENVELOPE_BLUEPRINT = [
  {
    key: "home",
    name: "Home base",
    slugs: ["housing", "rent-mortgage", "home-services"],
    required: true,
    priority: 1_000,
    targetBps: 10_500,
  },
  {
    key: "utilities",
    name: "Utilities & connectivity",
    slugs: ["utilities", "phone-internet", "home-utilities"],
    required: true,
    priority: 950,
    targetBps: 10_500,
  },
  {
    key: "insurance",
    name: "Insurance",
    slugs: ["insurance"],
    required: true,
    priority: 925,
    targetBps: 10_000,
  },
  {
    key: "debt",
    name: "Debt minimums",
    slugs: ["debt", "loan-payments"],
    required: true,
    priority: 900,
    targetBps: 10_000,
  },
  {
    key: "groceries",
    name: "Groceries",
    slugs: ["food", "groceries"],
    required: true,
    priority: 850,
    targetBps: 9_500,
  },
  {
    key: "transportation",
    name: "Transportation",
    slugs: ["transportation", "gas", "auto-maintenance", "transit-rides"],
    required: true,
    priority: 825,
    targetBps: 9_500,
  },
  {
    key: "health",
    name: "Health & fitness",
    slugs: ["health", "medical", "fitness"],
    required: false,
    priority: 700,
    targetBps: 9_000,
  },
  {
    key: "personal",
    name: "Personal & shopping",
    slugs: ["personal", "shopping", "personal-care", "gifts-giving", "education"],
    required: false,
    priority: 550,
    targetBps: 8_000,
  },
  {
    key: "dining",
    name: "Dining & coffee",
    slugs: ["dining-coffee"],
    required: false,
    priority: 500,
    targetBps: 7_500,
  },
  {
    key: "fun",
    name: "Fun, subscriptions & travel",
    slugs: ["fun", "subscriptions", "entertainment", "travel"],
    required: false,
    priority: 450,
    targetBps: 7_000,
  },
] as const;

export interface PersonalizationLedgerRow {
  id: string;
  accountId: string;
  accountGroup: string;
  accountType: string;
  merchantId: string | null;
  merchantName: string | null;
  amount: bigint;
  currency: string;
  transactedOn: string;
  normalizedDescription: string;
  fingerprint: string | null;
  categoryId: string | null;
  categorySlug: string | null;
  categoryKind: CategoryKind | null;
  categoryOrigin: CategoryOrigin;
  rootCategorySlug: string | null;
  status: "pending" | "posted" | "removed" | "void";
  isTransfer: boolean;
  isIncome: boolean;
  isExcluded: boolean;
  isReimbursement: boolean;
  reviewState: "none" | "needs_review" | "reviewed";
  userOverrideAt: string | null;
}

export interface CadenceResult {
  cadence: "weekly" | "biweekly" | "semimonthly" | "monthly" | "quarterly";
  intervalDays: number;
  confidenceBps: number;
  nextExpectedDate: string;
}

export interface PatternAnalysis {
  key: string;
  merchantId: string;
  merchantName: string;
  direction: Direction;
  currency: string;
  rows: PersonalizationLedgerRow[];
  cadence?: CadenceResult;
  typicalAmount: bigint;
  amountMin: bigint;
  amountMax: bigint;
  variabilityBps: number;
  dominantCategoryId: string | null;
  dominantCategorySlug: string | null;
  dominantCategoryKind: CategoryKind | null;
  categoryAgreementBps: number;
  trustedCategorizedRows: number;
  trustedCoverageBps: number;
}

export interface PersonalizationAnalysis {
  postedTransactions: number;
  categorizedTransactions: number;
  reviewTransactions: number;
  categoryCoverageBps: number;
  merchantPatterns: PatternAnalysis[];
  payroll: PatternAnalysis | null;
  recurringExpenses: PatternAnalysis[];
  duplicateCandidateGroups: number;
  duplicateCandidateIds: string[];
  transferPairs: number;
  refundCandidatePairs: Array<{
    refundId: string;
    purchaseId: string;
    amount: bigint;
    confidenceBps: number;
  }>;
  earliestDate: string | null;
  latestDate: string | null;
}

export interface PersonalizationApplySummary {
  mode: "dry-run" | "applied";
  planVersion: string;
  postedTransactions: number;
  categoryCoverageBps: number;
  reviewTransactions: number;
  payrollDetected: boolean;
  payrollCadence: CadenceResult["cadence"] | null;
  duplicateCandidateGroups: number;
  transferPairs: number;
  refundCandidates: number;
  taxonomyCategories: number;
  aiCalls: number;
  aiAccepted: number;
  aiPending: number;
  aiFailed: number;
  aiPreviouslyAttempted: number;
  deterministicMatches: number;
  readableAiRules: number;
  generatedRules: number;
  recurringSeries: number;
  bills: number;
  incomeSources: number;
  envelopes: number;
  budgetPeriods: number;
  goals: number;
  starterProfileApplied: boolean;
  expectedPaycheckMinorUnits: string | null;
  plannedPerPaycheckMinorUnits: string | null;
  planSurplusMinorUnits: string | null;
  planOverallocatedMinorUnits: string | null;
  requiredObligationShortfallMinorUnits: string | null;
}

export interface PersonalizeHouseholdInput {
  db: BetterWealthDatabase;
  config: AppConfig;
  householdId: string;
  userId: string;
  apply?: boolean;
  aiBatches?: number;
  aiBatchLimit?: number;
  employerHint?: string;
  starterProfile?: boolean;
  /** Explicitly opt managed paycheck allocations back into generated planning. */
  rebaseManagedBudget?: boolean;
  now?: Date;
  categorizeTransactions?: typeof categorizeHouseholdTransactions;
  testHooks?: {
    beforeLocalCommit?: () => void | Promise<void>;
  };
}

type CategoryRow = typeof categories.$inferSelect;

function stableId(kind: string, ...parts: string[]) {
  const digest = createHash("sha256")
    .update([PLAN_VERSION, kind, ...parts].join("\u001f"))
    .digest("hex");
  return `autoplan_${kind}_${digest.slice(0, 32)}`;
}

function dateOnly(value: string | Date): string {
  return (value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

function dateNumber(value: string): number {
  const parsed = Date.parse(`${value.slice(0, 10)}T12:00:00.000Z`);
  if (!Number.isFinite(parsed)) throw new RangeError(`Invalid date: ${value}`);
  return Math.floor(parsed / DAY_MS);
}

function addDays(value: string, days: number): string {
  return new Date((dateNumber(value) + days) * DAY_MS).toISOString().slice(0, 10);
}

function addMonths(value: string, months: number): string {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const target = new Date(Date.UTC(year!, month! - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day!, lastDay));
  return target.toISOString().slice(0, 10);
}

function median(values: readonly bigint[]): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return divideAndRound(sorted[middle - 1]! + sorted[middle]!, 2n, "half-even");
}

function ratioBps(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n || numerator <= 0n) return 0;
  const value = divideAndRound(numerator * 10_000n, denominator, "half-even");
  return Number(value > 10_000n ? 10_000n : value);
}

function roundToStep(value: bigint, step = 500n): bigint {
  if (value <= 0n) return 0n;
  return divideAndRound(value, step, "half-up") * step;
}

export function paychecksPerYear(cadence: CadenceResult["cadence"]): number {
  switch (cadence) {
    case "weekly":
      return 52;
    case "biweekly":
      return 26;
    case "semimonthly":
      return 24;
    case "quarterly":
      return 4;
    default:
      return 12;
  }
}

export function detectCadence(datesInput: readonly string[]): CadenceResult | undefined {
  const dates = [...new Set(datesInput.map(dateOnly))].sort();
  if (dates.length < 2) return undefined;
  const gaps = dates.slice(1).map((date, index) => dateNumber(date) - dateNumber(dates[index]!));
  const definitions = [
    { cadence: "weekly" as const, intervalDays: 7, tolerance: 2, minimumDates: 3 },
    { cadence: "biweekly" as const, intervalDays: 14, tolerance: 3, minimumDates: 3 },
    { cadence: "semimonthly" as const, intervalDays: 15, tolerance: 3, minimumDates: 3 },
    { cadence: "monthly" as const, intervalDays: 30, tolerance: 5, minimumDates: 2 },
    { cadence: "quarterly" as const, intervalDays: 91, tolerance: 12, minimumDates: 2 },
  ];
  const candidates = definitions.flatMap((definition) => {
    if (dates.length < definition.minimumDates) return [];
    const errors = gaps.map((gap) => Math.abs(gap - definition.intervalDays));
    const matching = errors.filter((error) => error <= definition.tolerance).length;
    if (matching * 4 < errors.length * 3) return [];
    const totalError = errors.reduce((sum, error) => sum + error, 0);
    const averageErrorBps = Math.round(
      (totalError * 10_000) / (errors.length * definition.intervalDays),
    );
    const confidenceBps = Math.max(
      6_500,
      Math.min(9_900, 8_000 + Math.min(1_000, dates.length * 200) - averageErrorBps),
    );
    return [{ ...definition, averageErrorBps, confidenceBps }];
  });
  candidates.sort(
    (left, right) =>
      left.averageErrorBps - right.averageErrorBps ||
      Math.abs(left.intervalDays - Number(median(gaps.map(BigInt)))) -
        Math.abs(right.intervalDays - Number(median(gaps.map(BigInt)))),
  );
  const selected = candidates[0];
  if (!selected) return undefined;
  const last = dates.at(-1)!;
  return {
    cadence: selected.cadence,
    intervalDays: selected.intervalDays,
    confidenceBps: selected.confidenceBps,
    nextExpectedDate:
      selected.cadence === "monthly"
        ? addMonths(last, 1)
        : selected.cadence === "quarterly"
          ? addMonths(last, 3)
          : addDays(last, selected.intervalDays),
  };
}

function trustedCategoryEvidence(row: PersonalizationLedgerRow) {
  if (!row.categoryId || !row.categorySlug || !row.categoryKind) return false;
  if (row.userOverrideAt || row.categoryOrigin === "user") return true;
  return (
    row.reviewState !== "needs_review" &&
    ["provider", "merchant_history", "rule"].includes(row.categoryOrigin)
  );
}

function dominantCategory(rows: readonly PersonalizationLedgerRow[]) {
  const counts = new Map<string, { count: number; id: string; slug: string; kind: CategoryKind }>();
  for (const row of rows) {
    if (!trustedCategoryEvidence(row)) continue;
    const categoryId = row.categoryId!;
    const current = counts.get(categoryId) ?? {
      count: 0,
      id: categoryId,
      slug: row.categorySlug!,
      kind: row.categoryKind!,
    };
    current.count += 1;
    counts.set(categoryId, current);
  }
  const ranked = [...counts.values()].sort(
    (left, right) => right.count - left.count || left.slug.localeCompare(right.slug),
  );
  const winner = ranked[0];
  const categorized = ranked.reduce((sum, item) => sum + item.count, 0);
  return {
    id: winner?.id ?? null,
    slug: winner?.slug ?? null,
    kind: winner?.kind ?? null,
    agreementBps: categorized > 0 ? Math.round(((winner?.count ?? 0) * 10_000) / categorized) : 0,
    trustedRows: categorized,
    coverageBps: rows.length > 0 ? Math.round((categorized * 10_000) / rows.length) : 0,
  };
}

function buildPattern(key: string, rows: PersonalizationLedgerRow[]): PatternAnalysis {
  const amounts = rows.map(({ amount }) => (amount < 0n ? -amount : amount));
  const typicalAmount = median(amounts);
  const minimum = amounts.reduce((best, value) => (value < best ? value : best), amounts[0] ?? 0n);
  const maximum = amounts.reduce((best, value) => (value > best ? value : best), amounts[0] ?? 0n);
  const category = dominantCategory(rows);
  const cadence = detectCadence(rows.map(({ transactedOn }) => transactedOn));
  return {
    key,
    merchantId: rows[0]!.merchantId!,
    merchantName: rows[0]!.merchantName!,
    direction: rows[0]!.amount >= 0n ? "inflow" : "outflow",
    currency: rows[0]!.currency,
    rows,
    ...(cadence ? { cadence } : {}),
    typicalAmount,
    amountMin: minimum,
    amountMax: maximum,
    variabilityBps: ratioBps(maximum - minimum, typicalAmount),
    dominantCategoryId: category.id,
    dominantCategorySlug: category.slug,
    dominantCategoryKind: category.kind,
    categoryAgreementBps: category.agreementBps,
    trustedCategorizedRows: category.trustedRows,
    trustedCoverageBps: category.coverageBps,
  };
}

function rowLooksLikeEmployer(row: PersonalizationLedgerRow, hintTokens: readonly string[]) {
  return [row.normalizedDescription, row.merchantName ?? ""].some((value) => {
    const evidenceTokens = normalizeDescription(value).split(" ").filter(Boolean);
    return hintTokens.every((hint) =>
      evidenceTokens.some(
        (evidence) => evidence === hint || evidence.startsWith(hint) || hint.startsWith(evidence),
      ),
    );
  });
}

function withCurrentPayrollAmount(pattern: PatternAnalysis): PatternAnalysis {
  const ordered = [...pattern.rows].sort(
    (left, right) =>
      left.transactedOn.localeCompare(right.transactedOn) || left.id.localeCompare(right.id),
  );
  let currentRows: PersonalizationLedgerRow[] | undefined;
  for (let start = 0; start <= ordered.length - 2; start += 1) {
    const suffix = ordered.slice(start);
    const amounts = suffix.map(({ amount }) => (amount < 0n ? -amount : amount));
    const typical = median(amounts);
    const minimum = amounts.reduce((best, value) => (value < best ? value : best), amounts[0]!);
    const maximum = amounts.reduce((best, value) => (value > best ? value : best), amounts[0]!);
    if (ratioBps(maximum - minimum, typical) <= 2_500) {
      currentRows = suffix;
      break;
    }
  }
  if (!currentRows || currentRows.length === ordered.length) return pattern;
  const amounts = currentRows.map(({ amount }) => (amount < 0n ? -amount : amount));
  const typicalAmount = median(amounts);
  const amountMin = amounts.reduce((best, value) => (value < best ? value : best), amounts[0]!);
  const amountMax = amounts.reduce((best, value) => (value > best ? value : best), amounts[0]!);
  return {
    ...pattern,
    typicalAmount,
    amountMin,
    amountMax,
    variabilityBps: ratioBps(amountMax - amountMin, typicalAmount),
  };
}

function billEligible(pattern: PatternAnalysis) {
  if (!pattern.cadence || pattern.direction !== "outflow") return false;
  const requiredRoots = new Set(["housing", "utilities", "debt", "health"]);
  if (pattern.rows.some((row) => row.rootCategorySlug && requiredRoots.has(row.rootCategorySlug))) {
    return pattern.variabilityBps <= 5_000;
  }
  return (
    pattern.dominantCategorySlug === "subscriptions" &&
    pattern.cadence.cadence === "monthly" &&
    pattern.variabilityBps <= 1_500
  );
}

export function analyzePersonalizationLedger(
  rowsInput: readonly PersonalizationLedgerRow[],
  input: { employerHint?: string; transferPairs?: number; currency?: string } = {},
): PersonalizationAnalysis {
  const posted = rowsInput.filter(({ status }) => status === "posted");
  const duplicateGroups = new Map<string, PersonalizationLedgerRow[]>();
  for (const row of posted) {
    if (!row.fingerprint) continue;
    const key = `${row.accountId}\u001f${row.fingerprint}`;
    duplicateGroups.set(key, [...(duplicateGroups.get(key) ?? []), row]);
  }
  const duplicateCandidateIds = [...duplicateGroups.values()].flatMap((group) =>
    [...group]
      .sort(
        (left, right) =>
          left.transactedOn.localeCompare(right.transactedOn) || left.id.localeCompare(right.id),
      )
      .slice(1)
      .map(({ id }) => id),
  );
  const duplicateCandidateIdSet = new Set(duplicateCandidateIds);
  const evidenceRows = posted.filter(
    (row) =>
      !duplicateCandidateIdSet.has(row.id) && (!input.currency || row.currency === input.currency),
  );
  const groups = new Map<string, PersonalizationLedgerRow[]>();
  for (const row of evidenceRows) {
    if (
      !row.merchantId ||
      !row.merchantName ||
      row.isTransfer ||
      row.isExcluded ||
      row.amount === 0n
    ) {
      continue;
    }
    const key = `${row.merchantId}\u001f${row.amount > 0n ? "inflow" : "outflow"}\u001f${row.currency}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const merchantPatterns = [...groups.entries()].map(([key, rows]) => buildPattern(key, rows));
  const payrollCandidates: PatternAnalysis[] = [];
  if (input.employerHint?.trim()) {
    const hintTokens = normalizeDescription(input.employerHint).split(" ").filter(Boolean);
    const employerGroups = new Map<string, PersonalizationLedgerRow[]>();
    for (const row of evidenceRows) {
      if (
        row.amount <= 0n ||
        row.isTransfer ||
        row.isExcluded ||
        row.isReimbursement ||
        !row.merchantId ||
        !row.merchantName ||
        !rowLooksLikeEmployer(row, hintTokens)
      ) {
        continue;
      }
      const key = `employer\u001f${row.accountId}\u001f${row.currency}`;
      employerGroups.set(key, [...(employerGroups.get(key) ?? []), row]);
    }
    for (const [key, rows] of employerGroups) {
      const candidate = withCurrentPayrollAmount(buildPattern(key, rows));
      if (candidate.rows.length >= 2 && candidate.cadence) payrollCandidates.push(candidate);
    }
  }
  payrollCandidates.sort(
    (left, right) =>
      right.rows.length - left.rows.length ||
      Number(right.typicalAmount - left.typicalAmount > 0n ? 1 : -1),
  );
  const payroll = payrollCandidates[0] ?? null;
  const recurringExpenses = merchantPatterns.filter(billEligible);

  const payrollIds = new Set(payroll?.rows.map(({ id }) => id) ?? []);
  const purchasesByMerchant = new Map<string, PersonalizationLedgerRow[]>();
  for (const row of evidenceRows) {
    if (
      !row.merchantId ||
      row.amount >= 0n ||
      row.isTransfer ||
      row.isExcluded ||
      REFUND_EXCLUDED_ACCOUNT_GROUPS.has(row.accountGroup)
    ) {
      continue;
    }
    purchasesByMerchant.set(row.merchantId, [
      ...(purchasesByMerchant.get(row.merchantId) ?? []),
      row,
    ]);
  }
  const refundCandidatePairs: PersonalizationAnalysis["refundCandidatePairs"] = [];
  const usedPurchaseIds = new Set<string>();
  for (const refund of evidenceRows) {
    if (
      !refund.merchantId ||
      refund.amount <= 0n ||
      refund.isTransfer ||
      REFUND_EXCLUDED_ACCOUNT_GROUPS.has(refund.accountGroup) ||
      payrollIds.has(refund.id)
    ) {
      continue;
    }
    const matches = (purchasesByMerchant.get(refund.merchantId) ?? [])
      .filter(
        (purchase) =>
          purchase.accountId === refund.accountId &&
          purchase.currency === refund.currency &&
          purchase.transactedOn < refund.transactedOn &&
          dateNumber(refund.transactedOn) - dateNumber(purchase.transactedOn) <= 90 &&
          -purchase.amount === refund.amount,
      )
      .sort((left, right) => right.transactedOn.localeCompare(left.transactedOn));
    const purchase = matches.find(({ id }) => !usedPurchaseIds.has(id));
    if (purchase) {
      usedPurchaseIds.add(purchase.id);
      refundCandidatePairs.push({
        refundId: refund.id,
        purchaseId: purchase.id,
        amount: refund.amount,
        confidenceBps: 9_500,
      });
    }
  }

  const categorizedTransactions = posted.filter(({ categoryId }) => categoryId !== null).length;
  return {
    postedTransactions: posted.length,
    categorizedTransactions,
    reviewTransactions: posted.filter(({ reviewState }) => reviewState === "needs_review").length,
    categoryCoverageBps:
      posted.length === 0 ? 0 : Math.round((categorizedTransactions * 10_000) / posted.length),
    merchantPatterns,
    payroll,
    recurringExpenses,
    duplicateCandidateGroups: [...duplicateGroups.values()].filter((group) => group.length > 1)
      .length,
    duplicateCandidateIds,
    transferPairs: input.transferPairs ?? 0,
    refundCandidatePairs,
    earliestDate: evidenceRows.length
      ? evidenceRows
          .map(({ transactedOn }) => transactedOn)
          .sort()[0]!
          .slice(0, 10)
      : null,
    latestDate: evidenceRows.length
      ? evidenceRows
          .map(({ transactedOn }) => transactedOn)
          .sort()
          .at(-1)!
          .slice(0, 10)
      : null,
  };
}

function rootCategorySlug(category: CategoryRow | undefined, byId: Map<string, CategoryRow>) {
  if (!category) return null;
  let current = category;
  const seen = new Set<string>();
  while (current.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current.slug;
}

async function loadLedgerRows(db: BetterWealthDatabase, householdId: string) {
  const [categoryRows, records] = await Promise.all([
    db.select().from(categories).where(eq(categories.householdId, householdId)),
    db
      .select({
        transaction: transactions,
        accountGroup: accounts.group,
        accountType: accounts.type,
        merchantName: merchants.name,
        category: categories,
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .leftJoin(merchants, eq(merchants.id, transactions.merchantId))
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .where(eq(transactions.householdId, householdId))
      .orderBy(asc(transactions.transactedOn), asc(transactions.id)),
  ]);
  const categoryById = new Map(categoryRows.map((category) => [category.id, category]));
  return {
    categoryRows,
    rows: records.map(({ transaction, accountGroup, accountType, merchantName, category }) => ({
      id: transaction.id,
      accountId: transaction.accountId,
      accountGroup,
      accountType,
      merchantId: transaction.merchantId,
      merchantName,
      amount: transaction.amount,
      currency: transaction.currency,
      transactedOn: transaction.transactedOn,
      normalizedDescription: transaction.normalizedDescription,
      fingerprint: transaction.fingerprint,
      categoryId: transaction.categoryId,
      categorySlug: category?.slug ?? null,
      categoryKind: category?.kind ?? null,
      categoryOrigin: transaction.categoryOrigin,
      rootCategorySlug: rootCategorySlug(category ?? undefined, categoryById),
      status: transaction.status,
      isTransfer: transaction.isTransfer,
      isIncome: transaction.isIncome,
      isExcluded: transaction.isExcluded,
      isReimbursement: transaction.isReimbursement,
      reviewState: transaction.reviewState,
      userOverrideAt: transaction.userOverrideAt,
    })) satisfies PersonalizationLedgerRow[],
  };
}

async function ensureTaxonomy(db: BetterWealthDatabase, householdId: string) {
  const existing = await db
    .select()
    .from(categories)
    .where(eq(categories.householdId, householdId));
  const bySlug = new Map(existing.map((category) => [category.slug, category]));
  let created = 0;
  let sortOrder = 100;
  for (const [slug, name, parentSlug, icon, color] of PERSONALIZATION_CATEGORY_BLUEPRINT) {
    const current = bySlug.get(slug);
    const parent = bySlug.get(parentSlug);
    if (!parent) throw new Error(`Personalization taxonomy requires parent category ${parentSlug}`);
    if (current) continue;
    const id = stableId("category", householdId, slug);
    const inserted = await db
      .insert(categories)
      .values({
        id,
        householdId,
        parentId: parent.id,
        name,
        slug,
        kind: parent.kind,
        color,
        icon,
        isActive: true,
        isSystem: true,
        sortOrder: sortOrder++,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) {
      bySlug.set(slug, inserted[0]!);
      created += 1;
    }
  }
  return { created, rows: [...bySlug.values()] };
}

function actionRows(value: unknown): RuleAction[] {
  const parsed = z.array(RuleActionSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

function readableRuleName(
  row: typeof rules.$inferSelect,
  categoryById: Map<string, CategoryRow>,
): string | undefined {
  const actions = actionRows(row.actions);
  const categoryId = actions.find((action) => action.type === "setCategory")?.categoryId;
  const category = categoryId ? categoryById.get(categoryId) : undefined;
  if (!category) return undefined;
  const merchant = actions.find((action) => action.type === "normalizeMerchant")?.merchant;
  const existingLeft = row.name.split("→")[0]?.trim();
  const label = merchant || existingLeft || "Learned pattern";
  return `${label} → ${category.name}`.slice(0, 160);
}

async function refineExistingAiRules(
  db: BetterWealthDatabase,
  householdId: string,
  categoryRows: CategoryRow[],
) {
  const categoryById = new Map(categoryRows.map((category) => [category.id, category]));
  const parentIds = new Set(
    categoryRows.flatMap((category) => (category.parentId ? [category.parentId] : [])),
  );
  const rows = await db
    .select()
    .from(rules)
    .where(and(eq(rules.householdId, householdId), eq(rules.origin, "ai")));
  let renamed = 0;
  let disabledBroad = 0;
  let movementActionsRewritten = 0;
  const broadCategoryIds = new Set<string>();
  for (const row of rows) {
    const actions = actionRows(row.actions);
    const categoryId = actions.find((action) => action.type === "setCategory")?.categoryId;
    const broad = Boolean(categoryId && parentIds.has(categoryId));
    const readableName = readableRuleName(row, categoryById);
    const opaqueGeneratedName = /autoplan_|[0-9A-HJKMNP-TV-Z]{26}/.test(row.name);
    const nextName = opaqueGeneratedName
      ? broad && readableName
        ? `${readableName} (broad, superseded)`.slice(0, 160)
        : readableName
      : undefined;
    const hasUnsafeMovementAction = actions.some(
      (action) =>
        action.type === "setFlag" &&
        action.value &&
        ["transfer", "reportingExcluded", "reimbursement"].includes(action.flag),
    );
    const safeActions = hasUnsafeMovementAction
      ? [
          ...actions.filter(
            (action) =>
              !(
                action.type === "setFlag" &&
                action.value &&
                ["transfer", "reportingExcluded", "reimbursement"].includes(action.flag)
              ),
          ),
          ...(actions.some((action) => action.type === "requestReview" && action.value)
            ? []
            : ([{ type: "requestReview", value: true }] satisfies RuleAction[])),
        ]
      : actions;
    const patch = {
      ...(nextName && nextName !== row.name ? { name: nextName } : {}),
      ...(broad && row.isEnabled ? { isEnabled: false } : {}),
      ...(hasUnsafeMovementAction
        ? { actions: safeActions as unknown as Record<string, unknown> }
        : {}),
    };
    if (Object.keys(patch).length > 0) {
      await db
        .update(rules)
        .set({ ...patch, updatedAt: new Date().toISOString() })
        .where(
          and(eq(rules.householdId, householdId), eq(rules.id, row.id), eq(rules.origin, "ai")),
        );
    }
    if (nextName && nextName !== row.name) renamed += 1;
    if (broad && row.isEnabled) disabledBroad += 1;
    if (hasUnsafeMovementAction) movementActionsRewritten += 1;
    if (broad && categoryId) broadCategoryIds.add(categoryId);
  }
  if (broadCategoryIds.size > 0) {
    await db
      .update(transactions)
      .set({ reviewState: "needs_review", updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(transactions.householdId, householdId),
          eq(transactions.categoryOrigin, "ai"),
          inArray(transactions.categoryId, [...broadCategoryIds]),
          isNull(transactions.userOverrideAt),
        ),
      );
  }
  return { renamed, disabledBroad, movementActionsRewritten };
}

async function repairHistoricalFlags(
  db: BetterWealthDatabase,
  householdId: string,
  categoryRows: CategoryRow[],
) {
  const [confirmedTransferRows, confirmedRefundRows] = await Promise.all([
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
  const confirmedTransferIds = [
    ...new Set(
      confirmedTransferRows.flatMap(({ outflowTransactionId, inflowTransactionId }) => [
        outflowTransactionId,
        inflowTransactionId,
      ]),
    ),
  ];
  const confirmedRefundIds = [
    ...new Set(confirmedRefundRows.map(({ refundTransactionId }) => refundTransactionId)),
  ];
  const confirmedMovementIds = [...new Set([...confirmedTransferIds, ...confirmedRefundIds])];
  const timestamp = new Date().toISOString();

  // System classifications may suggest a relationship, but only a confirmed relationship is
  // allowed to affect reporting. This also repairs flags written by older generated rules.
  await db
    .update(transactions)
    .set({
      isTransfer: false,
      isExcluded: false,
      isReimbursement: false,
      updatedAt: timestamp,
    })
    .where(
      and(
        eq(transactions.householdId, householdId),
        isNull(transactions.userOverrideAt),
        confirmedMovementIds.length ? notInArray(transactions.id, confirmedMovementIds) : undefined,
        or(
          eq(transactions.isTransfer, true),
          eq(transactions.isExcluded, true),
          eq(transactions.isReimbursement, true),
        ),
      ),
    );

  const idsByKind = new Map<CategoryKind, string[]>();
  for (const category of categoryRows) {
    idsByKind.set(category.kind, [...(idsByKind.get(category.kind) ?? []), category.id]);
  }
  const common = (categoryIds: string[]) =>
    and(
      eq(transactions.householdId, householdId),
      inArray(transactions.categoryId, categoryIds),
      isNull(transactions.userOverrideAt),
    );
  const incomeIds = idsByKind.get("income") ?? [];
  const expenseIds = idsByKind.get("expense") ?? [];
  const transferIds = idsByKind.get("transfer") ?? [];
  const nonIncomeIds = [...(idsByKind.get("debt") ?? []), ...(idsByKind.get("investment") ?? [])];
  if (incomeIds.length) {
    await db
      .update(transactions)
      .set({
        isIncome: true,
        updatedAt: timestamp,
      })
      .where(and(common(incomeIds), gt(transactions.amount, 0n), eq(transactions.isIncome, false)));
    await db
      .update(transactions)
      .set({
        isIncome: false,
        reviewState: "needs_review",
        updatedAt: timestamp,
      })
      .where(
        and(
          common(incomeIds),
          lt(transactions.amount, 0n),
          or(eq(transactions.isIncome, true), eq(transactions.reviewState, "none")),
        ),
      );
  }
  if (expenseIds.length) {
    await db
      .update(transactions)
      .set({
        isIncome: false,
        updatedAt: timestamp,
      })
      .where(and(common(expenseIds), lt(transactions.amount, 0n), eq(transactions.isIncome, true)));
    await db
      .update(transactions)
      .set({
        isIncome: false,
        reviewState: "needs_review",
        updatedAt: timestamp,
      })
      .where(
        and(
          common(expenseIds),
          gt(transactions.amount, 0n),
          confirmedRefundIds.length ? notInArray(transactions.id, confirmedRefundIds) : undefined,
          or(eq(transactions.isIncome, true), eq(transactions.reviewState, "none")),
        ),
      );
  }
  if (transferIds.length) {
    await db
      .update(transactions)
      .set({
        isIncome: false,
        reviewState: "needs_review",
        updatedAt: timestamp,
      })
      .where(
        and(
          common(transferIds),
          confirmedTransferIds.length
            ? notInArray(transactions.id, confirmedTransferIds)
            : undefined,
          or(eq(transactions.isIncome, true), eq(transactions.reviewState, "none")),
        ),
      );
  }
  if (nonIncomeIds.length) {
    await db
      .update(transactions)
      .set({
        isIncome: false,
        updatedAt: timestamp,
      })
      .where(and(common(nonIncomeIds), eq(transactions.isIncome, true)));
  }
  if (confirmedRefundIds.length) {
    await db
      .update(transactions)
      .set({
        isIncome: false,
        isTransfer: false,
        isExcluded: false,
        isReimbursement: true,
        updatedAt: timestamp,
      })
      .where(
        and(
          eq(transactions.householdId, householdId),
          inArray(transactions.id, confirmedRefundIds),
          isNull(transactions.userOverrideAt),
          or(
            eq(transactions.isIncome, true),
            eq(transactions.isTransfer, true),
            eq(transactions.isExcluded, true),
            eq(transactions.isReimbursement, false),
          ),
        ),
      );
  }
  if (confirmedTransferIds.length) {
    await db
      .update(transactions)
      .set({
        isIncome: false,
        isTransfer: true,
        isExcluded: true,
        isReimbursement: false,
        updatedAt: timestamp,
      })
      .where(
        and(
          eq(transactions.householdId, householdId),
          inArray(transactions.id, confirmedTransferIds),
          isNull(transactions.userOverrideAt),
          or(
            eq(transactions.isIncome, true),
            eq(transactions.isTransfer, false),
            eq(transactions.isExcluded, false),
            eq(transactions.isReimbursement, true),
          ),
        ),
      );
  }
}

async function downgradeLegacyUnconfirmedTransfers(db: BetterWealthDatabase, householdId: string) {
  const legacy = await db
    .select()
    .from(transfers)
    .where(
      and(
        eq(transfers.householdId, householdId),
        eq(transfers.status, "confirmed"),
        isNull(transfers.confirmedByUserId),
        inArray(transfers.matchedBy, ["provider", "fingerprint"]),
      ),
    );
  let downgraded = 0;
  const timestamp = new Date().toISOString();
  for (const transfer of legacy) {
    const transactionIds = [transfer.outflowTransactionId, transfer.inflowTransactionId];
    const sides = await db
      .select({ id: transactions.id, userOverrideAt: transactions.userOverrideAt })
      .from(transactions)
      .where(
        and(eq(transactions.householdId, householdId), inArray(transactions.id, transactionIds)),
      );
    if (sides.length !== 2 || sides.some(({ userOverrideAt }) => userOverrideAt !== null)) continue;
    const updated = await db
      .update(transfers)
      .set({ status: "suggested", updatedAt: timestamp })
      .where(
        and(
          eq(transfers.householdId, householdId),
          eq(transfers.id, transfer.id),
          eq(transfers.status, "confirmed"),
          isNull(transfers.confirmedByUserId),
        ),
      )
      .returning({ id: transfers.id });
    if (!updated.length) continue;
    await db
      .update(transactions)
      .set({
        isTransfer: false,
        isExcluded: false,
        reviewState: "needs_review",
        updatedAt: timestamp,
      })
      .where(
        and(
          eq(transactions.householdId, householdId),
          inArray(transactions.id, transactionIds),
          isNull(transactions.userOverrideAt),
        ),
      );
    downgraded += 1;
  }
  return downgraded;
}

async function expandAiInBatches(input: PersonalizeHouseholdInput) {
  const batchCount = Math.max(0, Math.min(20, input.aiBatches ?? 0));
  const batchLimit = Math.max(0, Math.min(50, input.aiBatchLimit ?? 25));
  const total = {
    aiCalls: 0,
    aiAccepted: 0,
    aiPending: 0,
    aiFailed: 0,
    aiPreviouslyAttempted: 0,
    deterministic: 0,
  };
  let stalledBatches = 0;
  const attemptedFingerprints = new Set<string>();
  const categorizeTransactions = input.categorizeTransactions ?? categorizeHouseholdTransactions;
  for (let batch = 0; batch < batchCount; batch += 1) {
    const result = await categorizeTransactions({
      db: input.db,
      config: input.config,
      householdId: input.householdId,
      userId: input.userId,
      aiLimit: batchLimit,
      attemptedFingerprints,
    });
    total.aiCalls += result.aiCalls;
    total.aiAccepted += result.aiAccepted;
    total.aiPending += result.aiPending;
    total.aiFailed += result.aiFailed;
    total.aiPreviouslyAttempted += result.aiPreviouslyAttempted;
    total.deterministic += result.deterministic;
    const progress = result.deterministic + result.aiAccepted + result.aiPending;
    stalledBatches = progress === 0 ? stalledBatches + 1 : 0;
    if (result.aiCalls === 0 || stalledBatches >= 2) break;
  }
  return total;
}

function completeMonthKeys(earliestDate: string | null, latestDate: string | null) {
  if (!earliestDate || !latestDate) return [];
  const keys: string[] = [];
  let cursor = addMonths(`${earliestDate.slice(0, 7)}-01`, 1).slice(0, 7);
  const exclusiveEnd = latestDate.slice(0, 7);
  while (cursor < exclusiveEnd && keys.length < 120) {
    keys.push(cursor);
    cursor = addMonths(`${cursor}-01`, 1).slice(0, 7);
  }
  return keys;
}

function observedMonthlySpend(
  rows: readonly PersonalizationLedgerRow[],
  categoryIds: ReadonlySet<string>,
  analysis: PersonalizationAnalysis,
) {
  const duplicateIds = new Set(analysis.duplicateCandidateIds);
  const spending = rows.filter(
    (row) =>
      row.status === "posted" &&
      !duplicateIds.has(row.id) &&
      row.amount < 0n &&
      !row.isTransfer &&
      !row.isExcluded &&
      row.categoryId !== null &&
      categoryIds.has(row.categoryId),
  );
  const completeMonths = completeMonthKeys(analysis.earliestDate, analysis.latestDate);
  if (completeMonths.length > 0) {
    const totals = completeMonths.map((month) =>
      spending
        .filter(({ transactedOn }) => transactedOn.slice(0, 7) === month)
        .reduce((sum, { amount }) => sum - amount, 0n),
    );
    return median(totals);
  }
  const total = spending.reduce((sum, { amount }) => sum - amount, 0n);
  if (!analysis.earliestDate || !analysis.latestDate || total === 0n) return 0n;
  const spanDays = Math.max(
    1,
    dateNumber(analysis.latestDate) - dateNumber(analysis.earliestDate) + 1,
  );
  return divideAndRound(total * 36_525n, BigInt(spanDays) * 1_200n, "half-even");
}

function monthlyEquivalent(amount: bigint, cadence: CadenceResult["cadence"]) {
  switch (cadence) {
    case "weekly":
      return divideAndRound(amount * 52n, 12n, "half-even");
    case "biweekly":
      return divideAndRound(amount * 26n, 12n, "half-even");
    case "semimonthly":
      return amount * 2n;
    case "quarterly":
      return divideAndRound(amount, 3n, "half-even");
    default:
      return amount;
  }
}

interface EnvelopePlan {
  id: string;
  key: string;
  name: string;
  categoryIds: string[];
  priority: number;
  required: boolean;
  observedMonthly: bigint;
  targetMonthly: bigint;
  targetPerPaycheck: bigint;
  plannedPerPaycheck: bigint;
}

export function buildEnvelopePlans(input: {
  householdId: string;
  categoryRows: CategoryRow[];
  rows: PersonalizationLedgerRow[];
  analysis: PersonalizationAnalysis;
  monthlyIncome: bigint;
  payrollCadence: CadenceResult["cadence"];
  expectedPaycheck: bigint;
}) {
  const annualPaychecks = paychecksPerYear(input.payrollCadence);
  const categoryBySlug = new Map(input.categoryRows.map((category) => [category.slug, category]));
  const initial: EnvelopePlan[] = ENVELOPE_BLUEPRINT.map((blueprint) => {
    const categoryIds = blueprint.slugs.flatMap((slug) => {
      const category = categoryBySlug.get(slug);
      return category ? [category.id] : [];
    });
    const categoryIdSet = new Set(categoryIds);
    const observedMonthly = observedMonthlySpend(input.rows, categoryIdSet, input.analysis);
    const recurringMonthly = input.analysis.recurringExpenses
      .filter(
        (pattern) =>
          pattern.cadence &&
          pattern.dominantCategoryId &&
          categoryIdSet.has(pattern.dominantCategoryId),
      )
      .reduce(
        (sum, pattern) => sum + monthlyEquivalent(pattern.typicalAmount, pattern.cadence!.cadence),
        0n,
      );
    const baseline = observedMonthly > recurringMonthly ? observedMonthly : recurringMonthly;
    const targetMonthly = roundToStep(
      divideAndRound(baseline * BigInt(blueprint.targetBps), 10_000n, "half-even"),
    );
    return {
      id: stableId("envelope", input.householdId, blueprint.key),
      key: blueprint.key,
      name: blueprint.name,
      categoryIds,
      priority: blueprint.priority,
      required: blueprint.required,
      observedMonthly,
      targetMonthly,
      targetPerPaycheck: divideAndRound(targetMonthly * 12n, BigInt(annualPaychecks), "half-even"),
      plannedPerPaycheck: 0n,
    };
  });
  const expenseCap = divideAndRound(input.monthlyIncome * 7_500n, 10_000n, "half-even");
  const requiredTotal = initial
    .filter(({ required }) => required)
    .reduce((sum, { targetMonthly }) => sum + targetMonthly, 0n);
  const discretionary = initial.filter(({ required }) => !required);
  const discretionaryTotal = discretionary.reduce(
    (sum, { targetMonthly }) => sum + targetMonthly,
    0n,
  );
  const discretionaryCapacity = expenseCap > requiredTotal ? expenseCap - requiredTotal : 0n;
  const scaleBps =
    discretionaryTotal > discretionaryCapacity && discretionaryTotal > 0n
      ? ratioBps(discretionaryCapacity, discretionaryTotal)
      : 10_000;
  const scaled = initial.map((plan) => {
    if (plan.required || scaleBps === 10_000) return plan;
    const targetMonthly = roundToStep(
      divideAndRound(plan.targetMonthly * BigInt(scaleBps), 10_000n, "half-even"),
    );
    return {
      ...plan,
      targetMonthly,
      targetPerPaycheck: divideAndRound(targetMonthly * 12n, BigInt(annualPaychecks), "half-even"),
    };
  });
  const ordered = [...scaled].sort(
    (left, right) =>
      Number(right.required) - Number(left.required) ||
      right.priority - left.priority ||
      left.key.localeCompare(right.key),
  );
  const plannedById = new Map<string, bigint>();
  let remaining = input.expectedPaycheck > 0n ? input.expectedPaycheck : 0n;
  for (const plan of ordered.filter(({ required }) => required)) {
    const planned = plan.targetPerPaycheck < remaining ? plan.targetPerPaycheck : remaining;
    plannedById.set(plan.id, planned);
    remaining -= planned;
  }
  const flexible = ordered.filter(({ required }) => !required);
  const flexibleTotal = flexible.reduce((sum, plan) => sum + plan.targetPerPaycheck, 0n);
  let flexibleRemaining = remaining < flexibleTotal ? remaining : flexibleTotal;
  let unallocatedFlexible = flexibleTotal;
  for (const plan of flexible) {
    const planned =
      unallocatedFlexible <= flexibleRemaining
        ? plan.targetPerPaycheck
        : unallocatedFlexible > 0n
          ? (plan.targetPerPaycheck * flexibleRemaining) / unallocatedFlexible
          : 0n;
    plannedById.set(plan.id, planned);
    flexibleRemaining -= planned;
    unallocatedFlexible -= plan.targetPerPaycheck;
  }
  return scaled.map((plan) => ({
    ...plan,
    plannedPerPaycheck: plannedById.get(plan.id) ?? 0n,
  }));
}

async function upsertEnvelopes(
  db: BetterWealthDatabase,
  householdId: string,
  currency: string,
  plans: EnvelopePlan[],
  analysis: PersonalizationAnalysis,
  annualPaychecks: number,
  rebaseManagedBudget: boolean,
) {
  const planIds = plans.map(({ id }) => id);
  if (rebaseManagedBudget && planIds.length) {
    await db
      .delete(envelopeCategoryLinks)
      .where(
        and(
          eq(envelopeCategoryLinks.householdId, householdId),
          inArray(envelopeCategoryLinks.envelopeId, planIds),
        ),
      );
  }
  for (const plan of plans) {
    const managedValues = {
      categoryId: plan.categoryIds[0] ?? null,
      cadence: "paycheck" as const,
      cadenceConfig: {
        source: PLAN_VERSION,
        observedMonthlyMinorUnits: plan.observedMonthly.toString(),
        monthlyAmountMinorUnits: plan.targetMonthly.toString(),
        paychecksPerYear: annualPaychecks,
        lookbackStart: analysis.earliestDate,
        lookbackEnd: analysis.latestDate,
      },
      priority: plan.priority,
      minimumAmount: plan.required ? plan.targetPerPaycheck : 0n,
      targetAmount: plan.targetPerPaycheck,
      currency,
      isRequired: plan.required,
    };
    const insert = db.insert(envelopes).values({
      id: plan.id,
      householdId,
      name: plan.name,
      ...managedValues,
      rolloverPolicy: "positive",
      isActive: true,
    });
    const written = await (rebaseManagedBudget
      ? insert.onConflictDoUpdate({ target: envelopes.id, set: managedValues })
      : insert.onConflictDoNothing()
    ).returning({ id: envelopes.id });
    if ((written.length || rebaseManagedBudget) && plan.categoryIds.length) {
      await db.insert(envelopeCategoryLinks).values(
        plan.categoryIds.map((categoryId) => ({
          householdId,
          envelopeId: plan.id,
          categoryId,
        })),
      );
    }
  }
  const links = planIds.length
    ? await db
        .select({
          envelopeId: envelopeCategoryLinks.envelopeId,
          categoryId: envelopeCategoryLinks.categoryId,
        })
        .from(envelopeCategoryLinks)
        .where(
          and(
            eq(envelopeCategoryLinks.householdId, householdId),
            inArray(envelopeCategoryLinks.envelopeId, planIds),
          ),
        )
    : [];
  return new Map(links.map(({ categoryId, envelopeId }) => [categoryId, envelopeId] as const));
}

function advanceExpectedDate(cadence: CadenceResult, nowDate: string) {
  let next = cadence.nextExpectedDate;
  let guard = 0;
  while (next < nowDate && guard < 120) {
    next =
      cadence.cadence === "monthly"
        ? addMonths(next, 1)
        : cadence.cadence === "quarterly"
          ? addMonths(next, 3)
          : addDays(next, cadence.intervalDays);
    guard += 1;
  }
  return next;
}

interface RecurrenceResult {
  recurringByPattern: Map<string, string>;
  payrollSeriesId: string | null;
  incomeSourceId: string | null;
  bills: number;
  series: number;
}

async function upsertRecurrences(input: {
  db: BetterWealthDatabase;
  householdId: string;
  analysis: PersonalizationAnalysis;
  categoryRows: CategoryRow[];
  envelopeByCategory: Map<string, string>;
  employerHint: string;
  currency: string;
  nowDate: string;
}): Promise<RecurrenceResult> {
  const recurringByPattern = new Map<string, string>();
  const categoryBySlug = new Map(input.categoryRows.map((category) => [category.slug, category]));
  const timestamp = new Date().toISOString();
  let payrollSeriesId: string | null = null;
  let incomeSourceId: string | null = null;
  let seriesCount = 0;
  let billCount = 0;

  const patterns = [
    ...(input.analysis.payroll ? [input.analysis.payroll] : []),
    ...input.analysis.recurringExpenses.filter(
      (pattern) => pattern.key !== input.analysis.payroll?.key,
    ),
  ];
  for (const pattern of patterns) {
    if (!pattern.cadence) continue;
    const isPayroll = pattern.key === input.analysis.payroll?.key;
    const categoryId = isPayroll
      ? (categoryBySlug.get("paycheck")?.id ?? pattern.dominantCategoryId)
      : pattern.dominantCategoryId;
    const recurringId = stableId(
      "recurrence",
      input.householdId,
      pattern.merchantId,
      pattern.direction,
    );
    const kind = isPayroll
      ? "income"
      : pattern.dominantCategorySlug === "subscriptions"
        ? "subscription"
        : "bill";
    const nextExpectedDate = advanceExpectedDate(pattern.cadence, input.nowDate);
    await input.db
      .insert(recurringSeries)
      .values({
        id: recurringId,
        householdId: input.householdId,
        merchantId: pattern.merchantId,
        accountId:
          new Set(pattern.rows.map(({ accountId }) => accountId)).size === 1
            ? pattern.rows[0]!.accountId
            : null,
        categoryId,
        name: isPayroll ? `${input.employerHint} payroll` : pattern.merchantName,
        kind,
        cadence: pattern.cadence.cadence,
        cadenceConfig: {
          source: PLAN_VERSION,
          intervalDays: pattern.cadence.intervalDays,
          observations: pattern.rows.length,
        },
        amountMin: pattern.amountMin,
        amountMax: pattern.amountMax,
        currency: input.currency,
        nextExpectedDate,
        lastObservedDate: pattern.rows
          .map(({ transactedOn }) => dateOnly(transactedOn))
          .sort()
          .at(-1),
        confidenceBps: Math.min(
          pattern.cadence.confidenceBps,
          Math.max(6_500, 10_000 - Math.floor(pattern.variabilityBps / 2)),
        ),
        status: "active",
      })
      .onConflictDoNothing();
    recurringByPattern.set(pattern.key, recurringId);
    seriesCount += 1;
    await input.db
      .update(transactions)
      .set({
        recurringSeriesId: recurringId,
        ...(isPayroll
          ? {
              categoryId,
              categoryOrigin: "rule" as const,
              isIncome: true,
              isReimbursement: false,
              reviewState: "none" as const,
            }
          : { isIncome: false }),
        updatedAt: timestamp,
      })
      .where(
        and(
          eq(transactions.householdId, input.householdId),
          inArray(
            transactions.id,
            pattern.rows.filter(({ userOverrideAt }) => !userOverrideAt).map(({ id }) => id),
          ),
          isNull(transactions.userOverrideAt),
        ),
      );

    if (isPayroll) {
      payrollSeriesId = recurringId;
      incomeSourceId = stableId("income", input.householdId, pattern.merchantId);
      await input.db
        .insert(incomeSources)
        .values({
          id: incomeSourceId,
          householdId: input.householdId,
          name: `${input.employerHint} payroll`,
          merchantId: pattern.merchantId,
          accountId: pattern.rows[0]!.accountId,
          recurringSeriesId: recurringId,
          cadence: pattern.cadence.cadence,
          cadenceConfig: {
            source: PLAN_VERSION,
            intervalDays: pattern.cadence.intervalDays,
            observations: pattern.rows.length,
          },
          typicalAmount: pattern.typicalAmount,
          currency: input.currency,
          nextExpectedDate,
          variabilityBps: pattern.variabilityBps,
          isActive: true,
          detectionRule: {
            source: PLAN_VERSION,
            direction: "inflow",
            merchantId: pattern.merchantId,
          },
        })
        .onConflictDoNothing();
      continue;
    }

    const billId = stableId("bill", input.householdId, pattern.merchantId, pattern.direction);
    const envelopeId = categoryId ? input.envelopeByCategory.get(categoryId) : undefined;
    await input.db
      .insert(bills)
      .values({
        id: billId,
        householdId: input.householdId,
        name: pattern.merchantName,
        recurringSeriesId: recurringId,
        envelopeId: envelopeId ?? null,
        autopayAccountId:
          new Set(pattern.rows.map(({ accountId }) => accountId)).size === 1
            ? pattern.rows[0]!.accountId
            : null,
        dueRule: {
          cadence: pattern.cadence.cadence,
          intervalDays: pattern.cadence.intervalDays,
          source: PLAN_VERSION,
        },
        amountMin: pattern.amountMin,
        amountMax: pattern.amountMax,
        currency: input.currency,
        recurrenceConfidenceBps: pattern.cadence.confidenceBps,
        nextDueDate: nextExpectedDate,
        isRequired: pattern.dominantCategorySlug !== "subscriptions",
        isActive: true,
      })
      .onConflictDoNothing();
    billCount += 1;
  }
  return {
    recurringByPattern,
    payrollSeriesId,
    incomeSourceId,
    bills: billCount,
    series: seriesCount,
  };
}

function classificationActions(
  category: CategoryRow,
  direction: Direction,
  envelopeId?: string,
  recurringSeriesId?: string,
) {
  const actions: RuleAction[] = [{ type: "setCategory", categoryId: category.id }];
  if (envelopeId) actions.push({ type: "setEnvelope", envelopeId });
  if (recurringSeriesId) {
    actions.push({ type: "attachRecurringSeries", recurringSeriesId });
  }
  if (category.kind === "income") {
    actions.push({ type: "setFlag", flag: "income", value: direction === "inflow" });
    actions.push({ type: "setFlag", flag: "reimbursement", value: false });
    if (direction === "outflow") actions.push({ type: "requestReview", value: true });
  } else if (category.kind === "expense") {
    actions.push({ type: "setFlag", flag: "income", value: false });
    if (direction === "inflow") actions.push({ type: "requestReview", value: true });
  } else if (category.kind === "transfer") {
    actions.push(
      { type: "setFlag", flag: "income", value: false },
      { type: "requestReview", value: true },
    );
  } else {
    actions.push({ type: "setFlag", flag: "income", value: false });
  }
  return actions;
}

function classificationPatch(category: CategoryRow, direction: Direction) {
  if (category.kind === "income") {
    return {
      isIncome: direction === "inflow",
      reviewState: direction === "outflow" ? ("needs_review" as const) : ("none" as const),
    };
  }
  if (category.kind === "expense") {
    return {
      isIncome: false,
      reviewState: direction === "inflow" ? ("needs_review" as const) : ("none" as const),
    };
  }
  if (category.kind === "transfer") {
    return {
      isIncome: false,
      reviewState: "needs_review" as const,
    };
  }
  return { isIncome: false, reviewState: "none" as const };
}

async function upsertPatternRules(input: {
  db: BetterWealthDatabase;
  householdId: string;
  userId: string;
  analysis: PersonalizationAnalysis;
  categoryRows: CategoryRow[];
  envelopeByCategory: Map<string, string>;
  recurrence: RecurrenceResult;
}) {
  const categoryById = new Map(input.categoryRows.map((category) => [category.id, category]));
  const categoryBySlug = new Map(input.categoryRows.map((category) => [category.slug, category]));
  const parentIds = new Set(
    input.categoryRows.flatMap((category) => (category.parentId ? [category.parentId] : [])),
  );
  const userRuleRows = await input.db
    .select({ priority: rules.priority })
    .from(rules)
    .where(
      and(
        eq(rules.householdId, input.householdId),
        eq(rules.origin, "user"),
        eq(rules.isEnabled, true),
      ),
    );
  const minimumUserPriority = userRuleRows.reduce(
    (minimum, row) => Math.min(minimum, row.priority),
    Number.POSITIVE_INFINITY,
  );
  if (minimumUserPriority <= -1_000_000) return 0;
  const generatedPriority = Number.isFinite(minimumUserPriority)
    ? Math.min(GENERATED_RULE_PRIORITY, minimumUserPriority - 1)
    : GENERATED_RULE_PRIORITY;
  const payrollRowIds = new Set(input.analysis.payroll?.rows.map(({ id }) => id) ?? []);
  let generated = 0;
  for (const pattern of input.analysis.merchantPatterns) {
    const isPayroll =
      payrollRowIds.size > 0 && pattern.rows.every(({ id }) => payrollRowIds.has(id));
    const category = isPayroll
      ? categoryBySlug.get("paycheck")
      : pattern.dominantCategoryId
        ? categoryById.get(pattern.dominantCategoryId)
        : undefined;
    if (
      !category ||
      pattern.trustedCategorizedRows < (isPayroll ? 1 : 2) ||
      pattern.trustedCoverageBps < TRUSTED_PATTERN_COVERAGE_BPS ||
      pattern.categoryAgreementBps < TRUSTED_PATTERN_AGREEMENT_BPS ||
      (category.kind === "income" && pattern.direction === "outflow") ||
      (!isPayroll && parentIds.has(category.id)) ||
      category.slug === "uncategorized"
    ) {
      continue;
    }
    const envelopeId = input.envelopeByCategory.get(category.id);
    const recurringSeriesId = isPayroll
      ? (input.recurrence.payrollSeriesId ?? undefined)
      : input.recurrence.recurringByPattern.get(pattern.key);
    const condition: RuleCondition = {
      all: [
        {
          field: "merchant",
          operator: "exact",
          value: pattern.merchantName,
          caseSensitive: false,
        },
        { field: "direction", operator: "exact", value: pattern.direction },
        {
          field: "currency",
          operator: "exact",
          value: pattern.currency,
          caseSensitive: false,
        },
      ],
    };
    const actions = classificationActions(
      category,
      pattern.direction,
      envelopeId,
      recurringSeriesId,
    );
    const id = stableId("rule", input.householdId, pattern.merchantId, pattern.direction);
    const timestamp = new Date().toISOString();
    const existingRule = await input.db
      .select({
        priority: rules.priority,
        isEnabled: rules.isEnabled,
        origin: rules.origin,
        actions: rules.actions,
      })
      .from(rules)
      .where(and(eq(rules.householdId, input.householdId), eq(rules.id, id)))
      .get();
    if (
      existingRule?.isEnabled &&
      existingRule.origin === "ai" &&
      Number.isFinite(minimumUserPriority) &&
      existingRule.priority >= minimumUserPriority
    ) {
      await input.db
        .update(rules)
        .set({ priority: generatedPriority, updatedAt: timestamp })
        .where(and(eq(rules.householdId, input.householdId), eq(rules.id, id)));
    }
    if (existingRule && existingRule.origin !== "ai") {
      continue;
    }
    if (existingRule) {
      // Stable personalization rule IDs are managed, so old unsafe movement actions can be
      // rewritten. A user-origin rule at the same ID is intentionally left untouched above.
      const existingActions = actionRows(existingRule.actions);
      const hasUnsafeMovementAction = existingActions.some(
        (action) =>
          action.type === "setFlag" &&
          action.value &&
          ["transfer", "reportingExcluded", "reimbursement"].includes(action.flag),
      );
      if (hasUnsafeMovementAction) {
        const safeActions = [
          ...existingActions.filter(
            (action) =>
              !(
                action.type === "setFlag" &&
                action.value &&
                ["transfer", "reportingExcluded", "reimbursement"].includes(action.flag)
              ),
          ),
          ...(existingActions.some((action) => action.type === "requestReview" && action.value)
            ? []
            : ([{ type: "requestReview", value: true }] satisfies RuleAction[])),
        ];
        await input.db
          .update(rules)
          .set({
            actions: safeActions as unknown as Record<string, unknown>,
            updatedAt: timestamp,
          })
          .where(
            and(eq(rules.householdId, input.householdId), eq(rules.id, id), eq(rules.origin, "ai")),
          );
      }
    } else {
      await input.db.insert(rules).values({
        id,
        householdId: input.householdId,
        name: `${pattern.merchantName} → ${category.name}`.slice(0, 160),
        priority: generatedPriority,
        isEnabled: true,
        origin: "ai",
        conditions: condition as unknown as Record<string, unknown>,
        actions: actions as unknown as Record<string, unknown>,
        specificityScore: ruleSpecificity(condition),
        createdByUserId: input.userId,
      });
    }
    if (envelopeId) {
      await input.db
        .insert(envelopeRuleLinks)
        .values({ householdId: input.householdId, envelopeId, ruleId: id })
        .onConflictDoNothing();
    }
    const historicalIds = pattern.rows
      .filter(
        ({ userOverrideAt, categoryOrigin }) =>
          !userOverrideAt && ["none", "ai", "merchant_history"].includes(categoryOrigin),
      )
      .map(({ id }) => id);
    if (historicalIds.length > 0) {
      await input.db
        .update(transactions)
        .set({
          categoryId: category.id,
          categoryOrigin: "rule",
          ...(envelopeId ? { envelopeId } : {}),
          ...(recurringSeriesId ? { recurringSeriesId } : {}),
          ...classificationPatch(category, pattern.direction),
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(transactions.householdId, input.householdId),
            inArray(transactions.id, historicalIds),
            isNull(transactions.userOverrideAt),
          ),
        );
    }
    generated += 1;
  }
  return generated;
}

async function upsertRefundSuggestions(
  db: BetterWealthDatabase,
  householdId: string,
  candidates: PersonalizationAnalysis["refundCandidatePairs"],
) {
  const managedCandidateIds = candidates.map(({ refundId, purchaseId }) =>
    stableId("refund", householdId, refundId, purchaseId),
  );
  await db
    .delete(refundLinks)
    .where(
      and(
        eq(refundLinks.householdId, householdId),
        eq(refundLinks.status, "suggested"),
        like(refundLinks.id, "autoplan_refund_%"),
        managedCandidateIds.length ? notInArray(refundLinks.id, managedCandidateIds) : undefined,
      ),
    );
  for (const candidate of candidates) {
    const inserted = await db
      .insert(refundLinks)
      .values({
        id: stableId("refund", householdId, candidate.refundId, candidate.purchaseId),
        householdId,
        refundTransactionId: candidate.refundId,
        purchaseTransactionId: candidate.purchaseId,
        amount: candidate.amount,
        confidenceBps: candidate.confidenceBps,
        status: "suggested",
      })
      .onConflictDoNothing()
      .returning({ status: refundLinks.status });
    void inserted;
  }
}

function currentPayCycle(pattern: PatternAnalysis, nowDate: string) {
  if (!pattern.cadence) return undefined;
  const observed = pattern.rows.map(({ transactedOn }) => dateOnly(transactedOn)).sort();
  let startsOn = observed.filter((date) => date <= nowDate).at(-1) ?? observed.at(-1)!;
  let next =
    pattern.cadence.cadence === "monthly"
      ? addMonths(startsOn, 1)
      : pattern.cadence.cadence === "quarterly"
        ? addMonths(startsOn, 3)
        : addDays(startsOn, pattern.cadence.intervalDays);
  let guard = 0;
  while (next <= nowDate && guard < 120) {
    startsOn = next;
    next =
      pattern.cadence.cadence === "monthly"
        ? addMonths(next, 1)
        : pattern.cadence.cadence === "quarterly"
          ? addMonths(next, 3)
          : addDays(next, pattern.cadence.intervalDays);
    guard += 1;
  }
  return { startsOn, endsOn: addDays(next, -1), nextPayday: next };
}

type ManagedBudgetActivityPiece = {
  sequence: number;
  amount: bigint;
  envelopeId: string | null;
  categoryId: string | null;
};

async function calculateManagedBudgetActivity(input: {
  db: BetterWealthDatabase;
  householdId: string;
  currency: string;
  startsOn: string;
  endsOn: string;
  eligibleEnvelopeIds: ReadonlySet<string>;
  envelopeByCategory: ReadonlyMap<string, string>;
}) {
  const activity = new Map<string, bigint>();
  const currentTransactions = await input.db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.householdId, input.householdId),
        eq(transactions.status, "posted"),
        eq(transactions.isExcluded, false),
        eq(transactions.isTransfer, false),
        eq(transactions.isIncome, false),
        eq(transactions.currency, input.currency),
        gte(transactions.transactedOn, input.startsOn),
        lte(transactions.transactedOn, input.endsOn),
      ),
    );
  const currentIds = currentTransactions.map(({ id }) => id);
  const confirmedRefunds = currentIds.length
    ? await input.db
        .select()
        .from(refundLinks)
        .where(
          and(
            eq(refundLinks.householdId, input.householdId),
            eq(refundLinks.status, "confirmed"),
            inArray(refundLinks.refundTransactionId, currentIds),
          ),
        )
        .orderBy(asc(refundLinks.createdAt), asc(refundLinks.id))
    : [];
  const purchaseIds = [
    ...new Set(confirmedRefunds.map(({ purchaseTransactionId }) => purchaseTransactionId)),
  ];
  const purchaseRows = purchaseIds.length
    ? await input.db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.householdId, input.householdId),
            inArray(transactions.id, purchaseIds),
          ),
        )
    : [];
  const transactionById = new Map(
    [...currentTransactions, ...purchaseRows].map((transaction) => [transaction.id, transaction]),
  );
  const allTransactionIds = [...transactionById.keys()];
  const splitRows = allTransactionIds.length
    ? await input.db
        .select()
        .from(transactionSplits)
        .where(
          and(
            eq(transactionSplits.householdId, input.householdId),
            inArray(transactionSplits.transactionId, allTransactionIds),
          ),
        )
        .orderBy(asc(transactionSplits.sequence), asc(transactionSplits.id))
    : [];
  const splitsByTransaction = new Map<string, ManagedBudgetActivityPiece[]>();
  for (const split of splitRows) {
    splitsByTransaction.set(split.transactionId, [
      ...(splitsByTransaction.get(split.transactionId) ?? []),
      {
        sequence: split.sequence,
        amount: split.amount,
        envelopeId: split.envelopeId,
        categoryId: split.categoryId,
      },
    ]);
  }
  const piecesFor = (transaction: typeof transactions.$inferSelect): ManagedBudgetActivityPiece[] =>
    splitsByTransaction.get(transaction.id) ?? [
      {
        sequence: 0,
        amount: transaction.amount,
        envelopeId: transaction.envelopeId,
        categoryId: transaction.categoryId,
      },
    ];
  const resolveEnvelope = (piece: ManagedBudgetActivityPiece) => {
    if (piece.envelopeId && input.eligibleEnvelopeIds.has(piece.envelopeId)) {
      return piece.envelopeId;
    }
    const mapped = piece.categoryId ? input.envelopeByCategory.get(piece.categoryId) : undefined;
    return mapped && input.eligibleEnvelopeIds.has(mapped) ? mapped : null;
  };
  const addActivity = (envelopeId: string, amount: bigint) => {
    activity.set(envelopeId, (activity.get(envelopeId) ?? 0n) + amount);
  };
  const refundsByTransaction = new Map<string, (typeof confirmedRefunds)[number][]>();
  for (const link of confirmedRefunds) {
    refundsByTransaction.set(link.refundTransactionId, [
      ...(refundsByTransaction.get(link.refundTransactionId) ?? []),
      link,
    ]);
  }
  for (const transaction of currentTransactions) {
    if (transaction.amount < 0n) {
      for (const piece of piecesFor(transaction)) {
        const envelopeId = resolveEnvelope(piece);
        if (envelopeId) addActivity(envelopeId, piece.amount);
      }
      continue;
    }

    // A positive expense-category transaction is only a review candidate. It becomes envelope
    // activity after a confirmed refund link, and it follows the original purchase allocation.
    let remainingCredit = transaction.amount;
    for (const link of refundsByTransaction.get(transaction.id) ?? []) {
      if (remainingCredit <= 0n) break;
      const purchase = transactionById.get(link.purchaseTransactionId);
      if (!purchase || purchase.amount >= 0n || purchase.currency !== input.currency) continue;
      const purchasePieces = piecesFor(purchase).flatMap((piece) => {
        const envelopeId = resolveEnvelope(piece);
        return envelopeId ? [{ piece, envelopeId }] : [];
      });
      const denominator = purchasePieces.reduce(
        (sum, { piece }) => sum + (piece.amount < 0n ? -piece.amount : piece.amount),
        0n,
      );
      if (denominator === 0n) continue;
      const refundable = link.amount < remainingCredit ? link.amount : remainingCredit;
      const apportioned = purchasePieces.map((item) => {
        const weight = item.piece.amount < 0n ? -item.piece.amount : item.piece.amount;
        const numerator = refundable * weight;
        return { ...item, amount: numerator / denominator, remainder: numerator % denominator };
      });
      let minorUnitsLeft = refundable - apportioned.reduce((sum, item) => sum + item.amount, 0n);
      apportioned.sort((left, right) =>
        left.remainder === right.remainder
          ? left.piece.sequence - right.piece.sequence
          : left.remainder > right.remainder
            ? -1
            : 1,
      );
      for (const item of apportioned) {
        const extra = minorUnitsLeft > 0n ? 1n : 0n;
        minorUnitsLeft -= extra;
        addActivity(item.envelopeId, item.amount + extra);
      }
      remainingCredit -= refundable;
    }
  }
  return activity;
}

const BUDGET_PROVENANCE_KEY = "planning.personalization_budget_provenance";
const BudgetProvenanceSchema = z.object({
  version: z.literal(PLAN_VERSION),
  budgetId: z.string().min(1),
  payCycleId: z.string().min(1),
  expectedIncomeMinorUnits: z.string().regex(/^\d+$/),
  managedAllocationBaselines: z.record(z.string(), z.string().regex(/^\d+$/)),
  preservedAllocationIds: z.array(z.string().min(1)).default([]),
});

const LegacyBudgetAuditSchema = z.object({
  expectedPaycheckMinorUnits: z.string().regex(/^\d+$/),
  budgetPeriodId: z.string().min(1).optional(),
  payCycleId: z.string().min(1).optional(),
});

const LegacyPersonalizationMarkerSchema = z.object({
  version: z.literal(PLAN_VERSION),
  employerHint: z.string().min(1),
});

type BudgetProvenance = z.infer<typeof BudgetProvenanceSchema>;

async function loadBudgetProvenance(db: BetterWealthDatabase, householdId: string) {
  const stored = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.householdId, householdId),
        eq(settings.scopeKey, "household"),
        eq(settings.key, BUDGET_PROVENANCE_KEY),
      ),
    )
    .get();
  if (!stored) return { exists: false, value: null as BudgetProvenance | null };
  const parsed = BudgetProvenanceSchema.safeParse(stored.value);
  return { exists: true, value: parsed.success ? parsed.data : null };
}

async function saveBudgetProvenance(
  db: BetterWealthDatabase,
  householdId: string,
  value: BudgetProvenance,
  timestamp: string,
) {
  await db
    .insert(settings)
    .values({
      id: stableId("setting", householdId, "personalization-budget-provenance"),
      householdId,
      userId: null,
      scopeKey: "household",
      key: BUDGET_PROVENANCE_KEY,
      value,
      isSecret: false,
    })
    .onConflictDoUpdate({
      target: [settings.householdId, settings.scopeKey, settings.key],
      set: { value, updatedAt: timestamp },
    });
}

async function upsertBudget(input: {
  db: BetterWealthDatabase;
  householdId: string;
  userId: string;
  currency: string;
  payroll: PatternAnalysis;
  incomeSourceId: string;
  envelopePlans: EnvelopePlan[];
  envelopeByCategory: Map<string, string>;
  nowDate: string;
  rebaseManagedBudget: boolean;
}) {
  const cycle = currentPayCycle(input.payroll, input.nowDate);
  if (!cycle) {
    return {
      budgetPeriods: 0,
      status: "draft" as const,
      expectedIncome: input.payroll.typicalAmount,
      plannedTotal: 0n,
      requiredPlannedTotal: 0n,
      requiredPerPaycheck: 0n,
      budgetPeriodId: null,
      payCycleId: null,
    };
  }
  const payCycleId = stableId("paycycle", input.householdId, input.incomeSourceId, cycle.startsOn);
  const actualIncome = input.payroll.rows
    .filter(({ transactedOn }) => {
      const day = dateOnly(transactedOn);
      return day >= cycle.startsOn && day <= cycle.endsOn;
    })
    .reduce((sum, { amount }) => sum + (amount > 0n ? amount : 0n), 0n);
  const timestamp = new Date().toISOString();
  const insertedPayCycles = await input.db
    .insert(payCycles)
    .values({
      id: payCycleId,
      householdId: input.householdId,
      incomeSourceId: input.incomeSourceId,
      startsOn: cycle.startsOn,
      endsOn: cycle.endsOn,
      expectedIncome: input.payroll.typicalAmount,
      actualIncome,
      currency: input.currency,
      status: "open",
    })
    .onConflictDoNothing()
    .returning({ id: payCycles.id });
  const budgetId = stableId("budget", input.householdId, "pay_cycle", cycle.startsOn, cycle.endsOn);
  const insertedBudgets = await input.db
    .insert(budgetPeriods)
    .values({
      id: budgetId,
      householdId: input.householdId,
      payCycleId,
      kind: "pay_cycle",
      startsOn: cycle.startsOn,
      endsOn: cycle.endsOn,
      currency: input.currency,
      expectedIncome: input.payroll.typicalAmount,
      actualIncome,
      status: "open",
    })
    .onConflictDoNothing()
    .returning({ id: budgetPeriods.id });
  const [currentBudget, currentCycleRow, existingAllocations, provenanceState] = await Promise.all([
    input.db
      .select()
      .from(budgetPeriods)
      .where(and(eq(budgetPeriods.householdId, input.householdId), eq(budgetPeriods.id, budgetId)))
      .get(),
    input.db
      .select()
      .from(payCycles)
      .where(and(eq(payCycles.householdId, input.householdId), eq(payCycles.id, payCycleId)))
      .get(),
    input.db
      .select()
      .from(envelopeAllocations)
      .where(
        and(
          eq(envelopeAllocations.householdId, input.householdId),
          eq(envelopeAllocations.budgetPeriodId, budgetId),
        ),
      ),
    loadBudgetProvenance(input.db, input.householdId),
  ]);
  if (!currentBudget || !currentCycleRow) {
    throw new Error("The managed paycheck budget could not be created");
  }
  if (provenanceState.exists && !provenanceState.value) {
    throw new Error("Managed paycheck budget provenance is invalid; refusing to overwrite it");
  }
  const requiredEnvelopeIds = new Set(
    input.envelopePlans.filter(({ required }) => required).map(({ id }) => id),
  );
  const requiredPerPaycheck = input.envelopePlans
    .filter(({ required }) => required)
    .reduce((sum, { targetPerPaycheck }) => sum + targetPerPaycheck, 0n);
  const summarizeExisting = () => ({
    budgetPeriods: 1,
    status: currentBudget.status,
    plannedTotal: existingAllocations.reduce((sum, allocation) => sum + allocation.planned, 0n),
    expectedIncome: currentBudget.expectedIncome,
    requiredPlannedTotal: existingAllocations
      .filter(({ envelopeId }) => requiredEnvelopeIds.has(envelopeId))
      .reduce((sum, allocation) => sum + allocation.planned, 0n),
    requiredPerPaycheck,
    budgetPeriodId: budgetId,
    payCycleId,
  });
  if (
    currentBudget.status !== "open" ||
    currentCycleRow.status === "closed" ||
    currentCycleRow.status === "skipped"
  ) {
    return summarizeExisting();
  }

  const provenance =
    provenanceState.value?.budgetId === budgetId && provenanceState.value.payCycleId === payCycleId
      ? provenanceState.value
      : null;
  const isNewManagedPeriod = insertedPayCycles.length === 1 && insertedBudgets.length === 1;
  if (insertedPayCycles.length !== insertedBudgets.length) {
    throw new Error("Managed paycheck budget provenance is incomplete; refusing partial repair");
  }
  if (provenance) {
    const previousExpectedIncome = BigInt(provenance.expectedIncomeMinorUnits);
    if (
      currentBudget.expectedIncome !== previousExpectedIncome ||
      currentCycleRow.expectedIncome !== previousExpectedIncome
    ) {
      throw new Error(
        "Managed paycheck income was edited after generation; refusing to overwrite it",
      );
    }
  } else if (!isNewManagedPeriod) {
    const latestAudit = await input.db
      .select({ metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.householdId, input.householdId),
          eq(auditEvents.action, "planning.personalized"),
        ),
      )
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
      .get();
    const parsedAudit = LegacyBudgetAuditSchema.safeParse(latestAudit?.metadata);
    let previousExpectedIncome: bigint;
    if (parsedAudit.success) {
      if (
        (parsedAudit.data.budgetPeriodId && parsedAudit.data.budgetPeriodId !== budgetId) ||
        (parsedAudit.data.payCycleId && parsedAudit.data.payCycleId !== payCycleId)
      ) {
        throw new Error(
          "Legacy paycheck budget has no trustworthy generation baseline; refusing to overwrite it",
        );
      }
      previousExpectedIncome = BigInt(parsedAudit.data.expectedPaycheckMinorUnits);
    } else {
      const legacyMarker = await input.db
        .select({ value: settings.value })
        .from(settings)
        .where(
          and(
            eq(settings.householdId, input.householdId),
            eq(settings.scopeKey, "household"),
            eq(settings.key, "planning.personalization"),
          ),
        )
        .get();
      if (!LegacyPersonalizationMarkerSchema.safeParse(legacyMarker?.value).success) {
        throw new Error(
          "Legacy paycheck budget has no trustworthy generation baseline; refusing to overwrite it",
        );
      }
      // Early BetterWealth builds wrote the versioned marker and stable managed IDs but not a
      // per-period baseline. Matching budget/pay-cycle values prove the pair is internally intact;
      // allocation rows are still preserved below because their edit history is unknowable.
      previousExpectedIncome = currentBudget.expectedIncome;
    }
    if (
      currentBudget.expectedIncome !== previousExpectedIncome ||
      currentCycleRow.expectedIncome !== previousExpectedIncome
    ) {
      throw new Error(
        "Legacy paycheck income differs from its last generated value; refusing to overwrite it",
      );
    }
  }
  const detectedExpectedIncome = input.payroll.typicalAmount;
  await input.db
    .update(payCycles)
    .set({
      expectedIncome: detectedExpectedIncome,
      actualIncome,
      updatedAt: timestamp,
    })
    .where(and(eq(payCycles.householdId, input.householdId), eq(payCycles.id, payCycleId)));
  await input.db
    .update(budgetPeriods)
    .set({
      expectedIncome: detectedExpectedIncome,
      actualIncome,
      updatedAt: timestamp,
    })
    .where(and(eq(budgetPeriods.householdId, input.householdId), eq(budgetPeriods.id, budgetId)));

  const orderedPlans = [...input.envelopePlans].sort(
    (left, right) =>
      Number(right.required) - Number(left.required) ||
      right.priority - left.priority ||
      left.name.localeCompare(right.name),
  );
  const managedIdByEnvelope = new Map(
    orderedPlans.map((plan) => [
      plan.id,
      stableId("allocation", input.householdId, budgetId, plan.id),
    ]),
  );
  const managedAllocationIds = new Set(managedIdByEnvelope.values());
  const existingByEnvelope = new Map(
    existingAllocations.map((allocation) => [allocation.envelopeId, allocation]),
  );
  const priorBaselines = provenance?.managedAllocationBaselines ?? {};
  const preservedManagedIds = new Set(
    input.rebaseManagedBudget ? [] : (provenance?.preservedAllocationIds ?? []),
  );
  const userEditedManagedIds = new Set<string>();
  if (provenance && !input.rebaseManagedBudget) {
    for (const plan of orderedPlans) {
      const existing = existingByEnvelope.get(plan.id);
      const managedId = managedIdByEnvelope.get(plan.id)!;
      if (!existing || existing.id !== managedId) continue;
      if (preservedManagedIds.has(managedId)) {
        userEditedManagedIds.add(managedId);
        continue;
      }
      const rawBaseline = priorBaselines[managedId];
      if (rawBaseline === undefined) {
        throw new Error(
          "Managed paycheck allocation provenance is incomplete; refusing to overwrite it",
        );
      }
      if (existing.planned !== BigInt(rawBaseline)) userEditedManagedIds.add(managedId);
    }
  } else if (!provenance && !isNewManagedPeriod && !input.rebaseManagedBudget) {
    // Old releases did not store per-allocation baselines. A stable ID proves ownership of the
    // row, not that the user never edited its value, so preserve it until the user opts back in.
    for (const plan of orderedPlans) {
      const existing = existingByEnvelope.get(plan.id);
      const managedId = managedIdByEnvelope.get(plan.id)!;
      if (!existing || existing.id !== managedId) continue;
      preservedManagedIds.add(managedId);
      userEditedManagedIds.add(managedId);
    }
  }
  const lockedPlanned = existingAllocations
    .filter(({ id }) => !managedAllocationIds.has(id) || userEditedManagedIds.has(id))
    .reduce((sum, allocation) => sum + allocation.planned, 0n);
  let managedPlannedCapacity =
    detectedExpectedIncome > lockedPlanned ? detectedExpectedIncome - lockedPlanned : 0n;
  const safePlannedByEnvelope = new Map<string, bigint>();
  for (const plan of orderedPlans) {
    const managedId = managedIdByEnvelope.get(plan.id)!;
    if (userEditedManagedIds.has(managedId)) continue;
    const safePlanned =
      plan.plannedPerPaycheck < managedPlannedCapacity
        ? plan.plannedPerPaycheck
        : managedPlannedCapacity;
    safePlannedByEnvelope.set(plan.id, safePlanned);
    managedPlannedCapacity -= safePlanned;
  }
  const activityByEnvelope = await calculateManagedBudgetActivity({
    db: input.db,
    householdId: input.householdId,
    currency: input.currency,
    startsOn: cycle.startsOn,
    endsOn: cycle.endsOn,
    eligibleEnvelopeIds: new Set(orderedPlans.map(({ id }) => id)),
    envelopeByCategory: input.envelopeByCategory,
  });
  const alreadyFunded = existingAllocations.reduce(
    (sum, allocation) => sum + allocation.funded,
    0n,
  );
  let remainingFunding =
    detectedExpectedIncome > alreadyFunded ? detectedExpectedIncome - alreadyFunded : 0n;
  const nextBaselines: Record<string, string> = {};
  for (const plan of orderedPlans) {
    const activity = activityByEnvelope.get(plan.id) ?? 0n;
    const existing = existingByEnvelope.get(plan.id);
    const managedId = managedIdByEnvelope.get(plan.id)!;
    if (existing) {
      const isManaged = existing.id === managedId;
      const userEdited = isManaged && userEditedManagedIds.has(managedId);
      const planned =
        isManaged && !userEdited ? (safePlannedByEnvelope.get(plan.id) ?? 0n) : existing.planned;
      await input.db
        .update(envelopeAllocations)
        .set({
          planned,
          activity,
          availableSnapshot:
            existing.funded + activity + existing.transferredIn - existing.transferredOut,
          calculatedAt: timestamp,
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(envelopeAllocations.householdId, input.householdId),
            eq(envelopeAllocations.id, existing.id),
          ),
        );
      if (isManaged) {
        nextBaselines[managedId] =
          userEdited && priorBaselines[managedId] !== undefined
            ? priorBaselines[managedId]!
            : planned.toString();
      }
      continue;
    }
    const planned = safePlannedByEnvelope.get(plan.id) ?? 0n;
    const funded = remainingFunding > planned ? planned : remainingFunding;
    remainingFunding -= funded;
    await input.db.insert(envelopeAllocations).values({
      id: managedId,
      householdId: input.householdId,
      budgetPeriodId: budgetId,
      envelopeId: plan.id,
      planned,
      funded,
      activity,
      transferredIn: 0n,
      transferredOut: 0n,
      availableSnapshot: funded + activity,
      currency: input.currency,
      calculatedAt: timestamp,
    });
    nextBaselines[managedId] = planned.toString();
  }
  await saveBudgetProvenance(
    input.db,
    input.householdId,
    {
      version: PLAN_VERSION,
      budgetId,
      payCycleId,
      expectedIncomeMinorUnits: detectedExpectedIncome.toString(),
      managedAllocationBaselines: nextBaselines,
      preservedAllocationIds: [...preservedManagedIds]
        .filter((id) => managedAllocationIds.has(id))
        .sort(),
    },
    timestamp,
  );
  const finalAllocations = await input.db
    .select({ envelopeId: envelopeAllocations.envelopeId, planned: envelopeAllocations.planned })
    .from(envelopeAllocations)
    .where(
      and(
        eq(envelopeAllocations.householdId, input.householdId),
        eq(envelopeAllocations.budgetPeriodId, budgetId),
      ),
    );
  return {
    budgetPeriods: 1,
    status: currentBudget.status,
    plannedTotal: finalAllocations.reduce((sum, allocation) => sum + allocation.planned, 0n),
    expectedIncome: detectedExpectedIncome,
    requiredPlannedTotal: finalAllocations
      .filter(({ envelopeId }) => requiredEnvelopeIds.has(envelopeId))
      .reduce((sum, allocation) => sum + allocation.planned, 0n),
    requiredPerPaycheck,
    budgetPeriodId: budgetId,
    payCycleId,
  };
}

function starterBirthDate(nowDate: string) {
  const [year, month, day] = nowDate.split("-").map(Number);
  const result = new Date(Date.UTC(year! - 22, month! - 1, day!));
  return result.toISOString().slice(0, 10);
}

function targetDateForAge(birthDate: string, targetAge: number) {
  const [year, month, day] = birthDate.split("-").map(Number);
  const targetYear = year! + targetAge;
  const lastDay = new Date(Date.UTC(targetYear, month!, 0)).getUTCDate();
  return `${targetYear.toString().padStart(4, "0")}-${month!.toString().padStart(2, "0")}-${Math.min(day!, lastDay).toString().padStart(2, "0")}`;
}

async function latestAccountState(db: BetterWealthDatabase, householdId: string) {
  const [accountRows, snapshots, assetRows, valuationRows] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.householdId, householdId)),
    db
      .select()
      .from(balanceSnapshots)
      .where(eq(balanceSnapshots.householdId, householdId))
      .orderBy(desc(balanceSnapshots.asOf), desc(balanceSnapshots.createdAt)),
    db
      .select()
      .from(assets)
      .where(and(eq(assets.householdId, householdId), eq(assets.isActive, true))),
    db
      .select()
      .from(assetValuations)
      .where(eq(assetValuations.householdId, householdId))
      .orderBy(desc(assetValuations.valuedOn), desc(assetValuations.createdAt)),
  ]);
  const latest = new Map<string, typeof balanceSnapshots.$inferSelect>();
  for (const snapshot of snapshots) {
    if (!latest.has(snapshot.accountId)) latest.set(snapshot.accountId, snapshot);
  }
  const latestValuations = new Map<string, typeof assetValuations.$inferSelect>();
  for (const valuation of valuationRows) {
    if (!latestValuations.has(valuation.assetId)) {
      latestValuations.set(valuation.assetId, valuation);
    }
  }
  return { accountRows, latest, assetRows, latestValuations };
}

async function upsertGoalsAndPreferences(input: {
  db: BetterWealthDatabase;
  householdId: string;
  userId: string;
  currency: string;
  payroll: PatternAnalysis;
  monthlyIncome: bigint;
  monthlyExpenses: bigint;
  requiredPerPaycheck: bigint;
  annualPaychecks: number;
  requiredObligationShortfall: bigint;
  employerHint: string;
  starterProfile: boolean;
  nowDate: string;
}) {
  const { accountRows, latest, assetRows, latestValuations } = await latestAccountState(
    input.db,
    input.householdId,
  );
  const profile = await input.db
    .select({ birthDate: users.birthDate, targetAge: users.targetAge })
    .from(users)
    .where(eq(users.id, input.userId))
    .get();
  if (!profile) throw new Error("User not found");
  const birthDate = profile.birthDate ?? starterBirthDate(input.nowDate);
  const targetAge = profile.targetAge ?? 30;
  const starterProfileApplied =
    input.starterProfile && (profile.birthDate === null || profile.targetAge === null);
  if (starterProfileApplied) {
    await input.db
      .update(users)
      .set({
        ...(profile.birthDate === null ? { birthDate } : {}),
        ...(profile.targetAge === null ? { targetAge } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(users.id, input.userId));
  }
  const activeAccountRows = accountRows.filter(({ status }) => status === "active");
  const payrollAccount = activeAccountRows.find(
    ({ id }) => id === input.payroll.rows[0]?.accountId,
  );
  const savingsAccounts = accountRows.filter(
    (account) =>
      account.status === "active" &&
      account.group === "cash" &&
      /saving|money.?market/i.test(`${account.name} ${account.type} ${account.subtype ?? ""}`),
  );
  const savingsAccount = savingsAccounts[0];
  const investmentAccount = activeAccountRows.find(
    (account) => account.group === "investment" && !isRetirementAccount(account),
  );
  const cryptoAccount = activeAccountRows.find(
    (account) => account.group === "crypto" && !account.isLiability,
  );
  const emergencyFundingAccount = savingsAccount ?? payrollAccount;
  const wealthFundingAccount =
    investmentAccount ?? cryptoAccount ?? savingsAccount ?? payrollAccount;
  const savingsBalance = savingsAccounts.reduce((sum, account) => {
    const snapshot = latest.get(account.id);
    if (!snapshot || snapshot.currency !== input.currency || snapshot.currentBalance <= 0n) {
      return sum;
    }
    return sum + snapshot.currentBalance;
  }, 0n);
  let liquidNetWorth = 0n;
  for (const account of accountRows) {
    const snapshot = latest.get(account.id);
    if (!snapshot || snapshot.currency !== input.currency) continue;
    liquidNetWorth += liquidAccountContribution(account, snapshot.currentBalance);
  }
  for (const asset of assetRows) {
    const valuation = latestValuations.get(asset.id);
    if (!valuation || valuation.currency !== input.currency) continue;
    liquidNetWorth += liquidAssetContribution(asset, valuation.amount);
  }
  const buffer =
    input.requiredPerPaycheck > STARTER_BUFFER_FLOOR
      ? input.requiredPerPaycheck
      : STARTER_BUFFER_FLOOR;
  const requiredMonthly = divideAndRound(
    input.requiredPerPaycheck * BigInt(input.annualPaychecks),
    12n,
    "half-even",
  );
  const emergencyTarget = requiredMonthly * 3n > buffer * 3n ? requiredMonthly * 3n : buffer * 3n;
  const monthlySurplus =
    input.monthlyIncome > input.monthlyExpenses ? input.monthlyIncome - input.monthlyExpenses : 0n;
  const emergencyFunded =
    savingsBalance > 0n
      ? savingsBalance < emergencyTarget
        ? savingsBalance
        : emergencyTarget
      : 0n;
  const emergencyComplete = emergencyFunded >= emergencyTarget;
  const emergencyContribution = emergencyComplete
    ? 0n
    : divideAndRound(monthlySurplus * 6_000n, 10_000n, "half-even");
  const wealthContribution = divideAndRound(
    monthlySurplus * BigInt(emergencyComplete ? 9_000 : 3_000),
    10_000n,
    "half-even",
  );
  const timestamp = new Date().toISOString();
  const emergencyGoalId = stableId("goal", input.householdId, "emergency-fund");
  await input.db
    .insert(goals)
    .values({
      id: emergencyGoalId,
      householdId: input.householdId,
      name: "Three-month safety net",
      type: "emergency_fund",
      targetAmount: emergencyTarget,
      fundedAmount: emergencyFunded,
      currency: input.currency,
      priority: 1,
      fundingAccountId: emergencyFundingAccount?.id ?? null,
      contributionPolicy: {
        managedBy: PLAN_VERSION,
        cadence: "monthly",
        monthlyAmountMinorUnits: emergencyContribution.toString(),
        surplusAllocationBps: emergencyComplete ? 0 : 6_000,
        requiredObligationShortfallMinorUnits: input.requiredObligationShortfall.toString(),
      },
      bufferPolicy: {
        managedBy: PLAN_VERSION,
        requiredMonths: 3,
        minimumBufferMinorUnits: buffer.toString(),
      },
      liquidityConstraint: "cash",
      status: emergencyComplete ? "completed" : "active",
      ...(emergencyComplete ? { completedAt: timestamp } : {}),
    })
    .onConflictDoNothing();

  let goalCount = 1;
  if (input.starterProfile) {
    const wealthGoalId = stableId("goal", input.householdId, "liquid-wealth-by-30");
    await input.db
      .insert(goals)
      .values({
        id: wealthGoalId,
        householdId: input.householdId,
        name: "$250k liquid by 30",
        type: "investment_milestone",
        targetAmount: STARTER_LIQUID_TARGET,
        fundedAmount: liquidNetWorth > 0n ? liquidNetWorth : 0n,
        currency: input.currency,
        targetDate: targetDateForAge(birthDate, targetAge),
        priority: 2,
        fundingAccountId: wealthFundingAccount?.id ?? null,
        contributionPolicy: {
          managedBy: PLAN_VERSION,
          cadence: "monthly",
          monthlyAmountMinorUnits: wealthContribution.toString(),
          surplusAllocationBps: emergencyComplete ? 9_000 : 3_000,
          requiredObligationShortfallMinorUnits: input.requiredObligationShortfall.toString(),
          starterAssumption: true,
        },
        bufferPolicy: {
          managedBy: PLAN_VERSION,
          preservesEmergencyGoalId: emergencyGoalId,
        },
        liquidityConstraint: "liquid",
        status: liquidNetWorth >= STARTER_LIQUID_TARGET ? "completed" : "active",
        ...(liquidNetWorth >= STARTER_LIQUID_TARGET ? { completedAt: timestamp } : {}),
      })
      .onConflictDoNothing();
    const managedWealthGoal = await input.db
      .select({
        contributionPolicy: goals.contributionPolicy,
        status: goals.status,
        completedAt: goals.completedAt,
      })
      .from(goals)
      .where(and(eq(goals.householdId, input.householdId), eq(goals.id, wealthGoalId)))
      .get();
    const contributionPolicy = managedWealthGoal?.contributionPolicy;
    const isManagedGoal =
      contributionPolicy !== null &&
      typeof contributionPolicy === "object" &&
      !Array.isArray(contributionPolicy) &&
      contributionPolicy.managedBy === PLAN_VERSION;
    if (managedWealthGoal && isManagedGoal) {
      const computedStatus =
        managedWealthGoal.status === "paused" || managedWealthGoal.status === "cancelled"
          ? managedWealthGoal.status
          : liquidNetWorth >= STARTER_LIQUID_TARGET
            ? "completed"
            : "active";
      await input.db
        .update(goals)
        .set({
          fundedAmount: liquidNetWorth > 0n ? liquidNetWorth : 0n,
          fundingAccountId: wealthFundingAccount?.id ?? null,
          status: computedStatus,
          completedAt:
            computedStatus === "completed" ? (managedWealthGoal.completedAt ?? timestamp) : null,
          updatedAt: timestamp,
        })
        .where(and(eq(goals.householdId, input.householdId), eq(goals.id, wealthGoalId)));
    }
    goalCount += 1;
  }

  const currentSetting = await input.db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.householdId, input.householdId),
        eq(settings.scopeKey, "household"),
        eq(settings.key, "planning.safe_to_spend"),
      ),
    )
    .get();
  const parsedSetting = z.record(z.string(), z.unknown()).safeParse(currentSetting?.value);
  const previous = parsedSetting.success ? parsedSetting.data : {};
  const previousBuffer =
    typeof previous.minimumBufferMinorUnits === "string" &&
    /^\d+$/.test(previous.minimumBufferMinorUnits)
      ? BigInt(previous.minimumBufferMinorUnits)
      : 0n;
  const nextBuffer = previousBuffer > buffer ? previousBuffer : buffer;
  const preferenceValue = {
    ...previous,
    minimumBufferMinorUnits: nextBuffer.toString(),
    ...(input.starterProfile && previous.targetLiquidNetWorthMinorUnits === undefined
      ? { targetLiquidNetWorthMinorUnits: STARTER_LIQUID_TARGET.toString() }
      : {}),
    ...(previous.spendableAccountIds === undefined && payrollAccount
      ? { spendableAccountIds: [payrollAccount.id] }
      : {}),
  };
  await input.db
    .insert(settings)
    .values({
      id: stableId("setting", input.householdId, "safe-to-spend"),
      householdId: input.householdId,
      userId: null,
      scopeKey: "household",
      key: "planning.safe_to_spend",
      value: preferenceValue,
      isSecret: false,
    })
    .onConflictDoUpdate({
      target: [settings.householdId, settings.scopeKey, settings.key],
      set: { value: preferenceValue, updatedAt: timestamp },
    });
  await input.db
    .insert(settings)
    .values({
      id: stableId("setting", input.householdId, "personalization"),
      householdId: input.householdId,
      userId: null,
      scopeKey: "household",
      key: "planning.personalization",
      value: {
        version: PLAN_VERSION,
        generatedAt: timestamp,
        employerHint: input.employerHint,
        starterAssumptions: input.starterProfile
          ? {
              currentAge: 22,
              targetAge: 30,
              liquidTargetMinorUnits: STARTER_LIQUID_TARGET.toString(),
              requiredObligationShortfallMinorUnits: input.requiredObligationShortfall.toString(),
              editable: true,
            }
          : null,
      },
      isSecret: false,
    })
    .onConflictDoUpdate({
      target: [settings.householdId, settings.scopeKey, settings.key],
      set: {
        value: {
          version: PLAN_VERSION,
          generatedAt: timestamp,
          employerHint: input.employerHint,
          starterAssumptions: input.starterProfile
            ? {
                currentAge: 22,
                targetAge: 30,
                liquidTargetMinorUnits: STARTER_LIQUID_TARGET.toString(),
                requiredObligationShortfallMinorUnits: input.requiredObligationShortfall.toString(),
                editable: true,
              }
            : null,
        },
        updatedAt: timestamp,
      },
    });

  return { goalCount, buffer, starterProfileApplied };
}

async function loadPersonalizationPreflight(
  db: BetterWealthDatabase,
  input: Pick<PersonalizeHouseholdInput, "householdId" | "userId"> & {
    employerHint: string;
    requirePayroll: boolean;
  },
) {
  const [household, user, membership, transferCount] = await Promise.all([
    db
      .select({ currency: households.baseCurrency })
      .from(households)
      .where(and(eq(households.id, input.householdId), eq(households.status, "active")))
      .get(),
    db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.userId), eq(users.status, "active")))
      .get(),
    db
      .select({ role: householdMembers.role })
      .from(householdMembers)
      .where(
        and(
          eq(householdMembers.householdId, input.householdId),
          eq(householdMembers.userId, input.userId),
          eq(householdMembers.status, "active"),
          inArray(householdMembers.role, ["owner", "admin"]),
        ),
      )
      .get(),
    db
      .select({ count: sql<number>`count(*)` })
      .from(transfers)
      .where(
        and(
          eq(transfers.householdId, input.householdId),
          inArray(transfers.status, ["suggested", "confirmed"]),
        ),
      )
      .get(),
  ]);
  if (!household || !user || !membership) {
    throw new Error(
      "Personalization requires an active owner or admin membership in the active target household",
    );
  }
  const ledger = await loadLedgerRows(db, input.householdId);
  const analysis = analyzePersonalizationLedger(ledger.rows, {
    employerHint: input.employerHint,
    currency: household.currency,
    transferPairs: transferCount?.count ?? 0,
  });
  if (input.requirePayroll && !analysis.payroll?.cadence) {
    throw new Error(
      `No clean recurring payroll evidence matched the employer hint “${input.employerHint}”`,
    );
  }
  return { household, ledger, analysis };
}

async function writePersonalizationJournal(
  db: BetterWealthDatabase,
  input: {
    householdId: string;
    userId: string;
    runId: string;
    phase: "provider_pending" | "local_pending" | "local_complete";
    timestamp: string;
    metadata?: Record<string, unknown>;
  },
) {
  const value = {
    version: PLAN_VERSION,
    runId: input.runId,
    phase: input.phase,
    actorUserId: input.userId,
    updatedAt: input.timestamp,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  await db
    .insert(settings)
    .values({
      id: stableId("setting", input.householdId, "personalization-journal"),
      householdId: input.householdId,
      userId: null,
      scopeKey: "household",
      key: "planning.personalization_journal",
      value,
      isSecret: false,
    })
    .onConflictDoUpdate({
      target: [settings.householdId, settings.scopeKey, settings.key],
      set: { value, updatedAt: input.timestamp },
    });
}

async function withImmediateTransaction<T>(
  db: BetterWealthDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  if (db.$client.inTransaction) {
    throw new Error("Personalization requires exclusive ownership of its SQLite connection");
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

async function runPersonalization(
  input: PersonalizeHouseholdInput,
): Promise<PersonalizationApplySummary> {
  const apply = input.apply ?? false;
  const employerHint = input.employerHint?.trim() || "Park Place Tech";
  const starterProfile = input.starterProfile ?? true;
  const now = input.now ?? new Date();
  const nowDate = dateOnly(now);
  const initial = await loadPersonalizationPreflight(input.db, {
    householdId: input.householdId,
    userId: input.userId,
    employerHint,
    requirePayroll: apply,
  });
  if (!apply) {
    return {
      mode: "dry-run",
      planVersion: PLAN_VERSION,
      postedTransactions: initial.analysis.postedTransactions,
      categoryCoverageBps: initial.analysis.categoryCoverageBps,
      reviewTransactions: initial.analysis.reviewTransactions,
      payrollDetected: initial.analysis.payroll !== null,
      payrollCadence: initial.analysis.payroll?.cadence?.cadence ?? null,
      duplicateCandidateGroups: initial.analysis.duplicateCandidateGroups,
      transferPairs: initial.analysis.transferPairs,
      refundCandidates: initial.analysis.refundCandidatePairs.length,
      taxonomyCategories: PERSONALIZATION_CATEGORY_BLUEPRINT.length,
      aiCalls: 0,
      aiAccepted: 0,
      aiPending: 0,
      aiFailed: 0,
      aiPreviouslyAttempted: 0,
      deterministicMatches: 0,
      readableAiRules: 0,
      generatedRules: 0,
      recurringSeries: initial.analysis.payroll ? 1 + initial.analysis.recurringExpenses.length : 0,
      bills: initial.analysis.recurringExpenses.length,
      incomeSources: initial.analysis.payroll ? 1 : 0,
      envelopes: ENVELOPE_BLUEPRINT.length,
      budgetPeriods: initial.analysis.payroll ? 1 : 0,
      goals: starterProfile ? 2 : 1,
      starterProfileApplied: false,
      expectedPaycheckMinorUnits: initial.analysis.payroll?.typicalAmount.toString() ?? null,
      plannedPerPaycheckMinorUnits: null,
      planSurplusMinorUnits: null,
      planOverallocatedMinorUnits: null,
      requiredObligationShortfallMinorUnits: null,
    };
  }

  const runId = randomUUID();
  const requestedAiBatches = Math.max(0, Math.min(20, input.aiBatches ?? 0));
  if (requestedAiBatches > 0) {
    const journalTimestamp = new Date().toISOString();
    await ensureTaxonomy(input.db, input.householdId);
    await writePersonalizationJournal(input.db, {
      householdId: input.householdId,
      userId: input.userId,
      runId,
      phase: "provider_pending",
      timestamp: journalTimestamp,
      metadata: { requestedAiBatches, taxonomyReady: true },
    });
  }
  const ai = await expandAiInBatches({
    ...input,
    employerHint,
    starterProfile,
    now,
    aiBatches: requestedAiBatches,
  });

  await loadPersonalizationPreflight(input.db, {
    householdId: input.householdId,
    userId: input.userId,
    employerHint,
    requirePayroll: true,
  });
  await writePersonalizationJournal(input.db, {
    householdId: input.householdId,
    userId: input.userId,
    runId,
    phase: "local_pending",
    timestamp: new Date().toISOString(),
    metadata: { atomic: true },
  });
  const local = await withImmediateTransaction(input.db, async () => {
    const db = input.db;
    const transactionalPreflight = await loadPersonalizationPreflight(db, {
      householdId: input.householdId,
      userId: input.userId,
      employerHint,
      requirePayroll: true,
    });
    const taxonomy = await ensureTaxonomy(db, input.householdId);
    const legacyTransfersDowngraded = await downgradeLegacyUnconfirmedTransfers(
      db,
      input.householdId,
    );
    const refinedAiRules = await refineExistingAiRules(db, input.householdId, taxonomy.rows);
    await repairHistoricalFlags(db, input.householdId, taxonomy.rows);
    let ledger = await loadLedgerRows(db, input.householdId);
    let analysis = analyzePersonalizationLedger(ledger.rows, {
      employerHint,
      currency: transactionalPreflight.household.currency,
      transferPairs: transactionalPreflight.analysis.transferPairs,
    });
    if (!analysis.payroll?.cadence) {
      throw new Error(
        `No clean recurring payroll evidence matched the employer hint “${employerHint}”`,
      );
    }
    const annualPaychecks = paychecksPerYear(analysis.payroll.cadence.cadence);
    const monthlyIncome = monthlyEquivalent(
      analysis.payroll.typicalAmount,
      analysis.payroll.cadence.cadence,
    );
    const envelopePlans = buildEnvelopePlans({
      householdId: input.householdId,
      categoryRows: ledger.categoryRows,
      rows: ledger.rows,
      analysis,
      monthlyIncome,
      payrollCadence: analysis.payroll.cadence.cadence,
      expectedPaycheck: analysis.payroll.typicalAmount,
    });
    const envelopeByCategory = await upsertEnvelopes(
      db,
      input.householdId,
      transactionalPreflight.household.currency,
      envelopePlans,
      analysis,
      annualPaychecks,
      input.rebaseManagedBudget ?? false,
    );
    const recurrence = await upsertRecurrences({
      db,
      householdId: input.householdId,
      analysis,
      categoryRows: ledger.categoryRows,
      envelopeByCategory,
      employerHint,
      currency: transactionalPreflight.household.currency,
      nowDate,
    });
    const generatedRules = await upsertPatternRules({
      db,
      householdId: input.householdId,
      userId: input.userId,
      analysis,
      categoryRows: ledger.categoryRows,
      envelopeByCategory,
      recurrence,
    });
    ledger = await loadLedgerRows(db, input.householdId);
    analysis = analyzePersonalizationLedger(ledger.rows, {
      employerHint,
      currency: transactionalPreflight.household.currency,
      transferPairs: transactionalPreflight.analysis.transferPairs,
    });
    if (!recurrence.incomeSourceId || !analysis.payroll?.cadence) {
      throw new Error("The payroll income source could not be created");
    }
    await upsertRefundSuggestions(db, input.householdId, analysis.refundCandidatePairs);
    const budget = await upsertBudget({
      db,
      householdId: input.householdId,
      userId: input.userId,
      currency: transactionalPreflight.household.currency,
      payroll: analysis.payroll,
      incomeSourceId: recurrence.incomeSourceId,
      envelopePlans,
      envelopeByCategory,
      nowDate,
      rebaseManagedBudget: input.rebaseManagedBudget ?? false,
    });
    const expectedPaycheck = budget.expectedIncome;
    const plannedPerPaycheck = budget.plannedTotal;
    const requiredTarget = envelopePlans
      .filter(({ required }) => required)
      .reduce((sum, plan) => sum + plan.targetPerPaycheck, 0n);
    const requiredPlanned = budget.requiredPlannedTotal;
    const requiredShortfall =
      requiredTarget > requiredPlanned ? requiredTarget - requiredPlanned : 0n;
    const monthlyExpenses = divideAndRound(
      plannedPerPaycheck * BigInt(annualPaychecks),
      12n,
      "half-even",
    );
    const planning = await upsertGoalsAndPreferences({
      db,
      householdId: input.householdId,
      userId: input.userId,
      currency: transactionalPreflight.household.currency,
      payroll: analysis.payroll,
      monthlyIncome,
      monthlyExpenses,
      requiredPerPaycheck: budget.requiredPerPaycheck,
      annualPaychecks,
      requiredObligationShortfall: requiredShortfall,
      employerHint,
      starterProfile,
      nowDate,
    });
    const planSurplus =
      expectedPaycheck > plannedPerPaycheck ? expectedPaycheck - plannedPerPaycheck : 0n;
    const planOverallocated =
      plannedPerPaycheck > expectedPaycheck ? plannedPerPaycheck - expectedPaycheck : 0n;
    const timestamp = new Date().toISOString();
    await db.insert(auditEvents).values({
      id: `autoplan_audit_${randomUUID()}`,
      householdId: input.householdId,
      actorUserId: input.userId,
      actorType: "system",
      action: "planning.personalized",
      entityType: "household",
      entityId: input.householdId,
      metadata: {
        version: PLAN_VERSION,
        runId,
        postedTransactions: analysis.postedTransactions,
        categoryCoverageBps: analysis.categoryCoverageBps,
        generatedRules,
        bills: recurrence.bills,
        envelopes: envelopePlans.length,
        goals: planning.goalCount,
        expectedPaycheckMinorUnits: expectedPaycheck.toString(),
        plannedPerPaycheckMinorUnits: plannedPerPaycheck.toString(),
        planSurplusMinorUnits: planSurplus.toString(),
        planOverallocatedMinorUnits: planOverallocated.toString(),
        requiredObligationShortfallMinorUnits: requiredShortfall.toString(),
        legacyTransfersDowngraded,
        aiMovementRulesRewritten: refinedAiRules.movementActionsRewritten,
        managedBudgetRebased: input.rebaseManagedBudget ?? false,
        budgetPeriodId: budget.budgetPeriodId,
        payCycleId: budget.payCycleId,
      },
    });
    await input.testHooks?.beforeLocalCommit?.();
    return {
      analysis,
      recurrence,
      generatedRules,
      envelopePlans,
      budget,
      planning,
      expectedPaycheck,
      plannedPerPaycheck,
      planSurplus,
      planOverallocated,
      requiredShortfall,
      legacyTransfersDowngraded,
      refinedAiRules,
    };
  });
  await writePersonalizationJournal(input.db, {
    householdId: input.householdId,
    userId: input.userId,
    runId,
    phase: "local_complete",
    timestamp: new Date().toISOString(),
    metadata: {
      expectedPaycheckMinorUnits: local.expectedPaycheck.toString(),
      plannedPerPaycheckMinorUnits: local.plannedPerPaycheck.toString(),
      planSurplusMinorUnits: local.planSurplus.toString(),
      planOverallocatedMinorUnits: local.planOverallocated.toString(),
      requiredObligationShortfallMinorUnits: local.requiredShortfall.toString(),
      legacyTransfersDowngraded: local.legacyTransfersDowngraded,
      aiMovementRulesRewritten: local.refinedAiRules.movementActionsRewritten,
    },
  });

  const [readableAiRuleCount, suggestionStatuses] = await Promise.all([
    input.db
      .select({ count: sql<number>`count(*)` })
      .from(rules)
      .where(and(eq(rules.householdId, input.householdId), eq(rules.origin, "ai")))
      .get(),
    input.db
      .select({ status: aiSuggestions.status, count: sql<number>`count(*)` })
      .from(aiSuggestions)
      .where(eq(aiSuggestions.householdId, input.householdId))
      .groupBy(aiSuggestions.status),
  ]);
  const totalPending = suggestionStatuses.find(({ status }) => status === "pending")?.count ?? 0;
  return {
    mode: "applied",
    planVersion: PLAN_VERSION,
    postedTransactions: local.analysis.postedTransactions,
    categoryCoverageBps: local.analysis.categoryCoverageBps,
    reviewTransactions: local.analysis.reviewTransactions,
    payrollDetected: true,
    payrollCadence: local.analysis.payroll?.cadence?.cadence ?? null,
    duplicateCandidateGroups: local.analysis.duplicateCandidateGroups,
    transferPairs: local.analysis.transferPairs,
    refundCandidates: local.analysis.refundCandidatePairs.length,
    taxonomyCategories: PERSONALIZATION_CATEGORY_BLUEPRINT.length,
    aiCalls: ai.aiCalls,
    aiAccepted: ai.aiAccepted,
    aiPending: totalPending,
    aiFailed: ai.aiFailed,
    aiPreviouslyAttempted: ai.aiPreviouslyAttempted,
    deterministicMatches: ai.deterministic,
    readableAiRules: readableAiRuleCount?.count ?? 0,
    generatedRules: local.generatedRules,
    recurringSeries: local.recurrence.series,
    bills: local.recurrence.bills,
    incomeSources: 1,
    envelopes: local.envelopePlans.length,
    budgetPeriods: local.budget.budgetPeriods,
    goals: local.planning.goalCount,
    starterProfileApplied: local.planning.starterProfileApplied,
    expectedPaycheckMinorUnits: local.expectedPaycheck.toString(),
    plannedPerPaycheckMinorUnits: local.plannedPerPaycheck.toString(),
    planSurplusMinorUnits: local.planSurplus.toString(),
    planOverallocatedMinorUnits: local.planOverallocated.toString(),
    requiredObligationShortfallMinorUnits: local.requiredShortfall.toString(),
  };
}

export async function personalizeHousehold(
  input: PersonalizeHouseholdInput,
): Promise<PersonalizationApplySummary> {
  return runPersonalization(input);
}
