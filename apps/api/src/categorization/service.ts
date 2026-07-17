import type { BetterWealthDatabase } from "@betterwealth/db";
import {
  accounts,
  aiSuggestions,
  auditEvents,
  categories,
  connections,
  merchants,
  refundLinks,
  ruleRuns,
  rules,
  settings,
  transactions,
} from "@betterwealth/db/schema";
import {
  type CategorizationRule,
  CategorizationRuleSchema,
  evaluateRules,
  matchesRuleCondition,
  money,
  type RuleAction,
  type RuleCondition,
  type RuleTransaction,
  ruleSpecificity,
  transactionRulePatchToJson,
} from "@betterwealth/shared";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";
import type { AppConfig } from "../config";
import {
  type CategorizationSuggestion,
  coarseAmountBand,
  suggestTransactionCategory,
  verifyTransactionCategorization,
} from "../integrations/openrouter";
import { FieldCipher, sha256 } from "../lib/crypto";
import { AppError } from "../lib/errors";
import { normalizeDescription } from "../sync/reconcile";

const aiSecretSchema = z.object({
  enabled: z.boolean(),
  consent: z.literal(true),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  apiKey: z.string().min(10),
  confidenceThreshold: z.number().min(0).max(1),
  webResearchEnabled: z.boolean().default(false),
});

type TransactionContext = {
  transaction: typeof transactions.$inferSelect;
  account: typeof accounts.$inferSelect;
  connectionOwnerUserId: string | null;
  merchantName: string | null;
};

type CategoryKind = "income" | "expense" | "transfer" | "debt" | "investment";

const AI_RUN_DEADLINE_MS = 120_000;
// Authentication, rate-limit, and unsafe-egress failures still open immediately. A small run of
// schema-invalid model replies is tolerated because free OpenAI-compatible models can be noisy
// even after a successful synthetic preflight.
const MAX_CONSECUTIVE_PROVIDER_FAILURES = 5;
const PROVIDER_CIRCUIT_SENTINEL = "__betterwealth_ai_provider_circuit_open__";

type ActiveCategoryRow = {
  id: string;
  name: string;
  parentId: string | null;
  kind: CategoryKind;
};

class EvaluatedTransactionChangedError extends Error {
  constructor() {
    super("The transaction changed after AI categorization was evaluated");
    this.name = "EvaluatedTransactionChangedError";
  }
}

/**
 * Returns the disclosure/fingerprint scope for AI work, or undefined when the acting user's
 * consent does not cover this account. Connected accounts inherit their connection owner when the
 * account owner is absent. Ownerless/shared and conflicting owner metadata fail closed because
 * BetterWealth does not yet have a separate household-wide disclosure consent.
 */
function aiDisclosureScope(row: TransactionContext, userId: string): string | undefined {
  const owners = new Set(
    [row.account.ownerUserId, row.connectionOwnerUserId].filter((owner): owner is string =>
      Boolean(owner),
    ),
  );
  if (owners.size === 0) return undefined;
  if (owners.size === 1 && owners.has(userId)) return `user:${userId}`;
  return undefined;
}

function classificationFlagActions(
  kind: CategoryKind | undefined,
  direction: "inflow" | "outflow",
) {
  const actions: RuleAction[] = [];
  if (kind === "income") {
    actions.push(
      { type: "setFlag", flag: "transfer", value: false },
      { type: "setFlag", flag: "reportingExcluded", value: false },
      { type: "setFlag", flag: "income", value: direction === "inflow" },
      { type: "setFlag", flag: "reimbursement", value: false },
    );
    if (direction === "outflow") actions.push({ type: "requestReview", value: true });
  } else if (kind === "expense") {
    actions.push(
      { type: "setFlag", flag: "transfer", value: false },
      { type: "setFlag", flag: "reportingExcluded", value: false },
      { type: "setFlag", flag: "income", value: false },
      { type: "setFlag", flag: "reimbursement", value: false },
    );
    if (direction === "inflow") actions.push({ type: "requestReview", value: true });
  } else if (kind === "transfer") {
    actions.push(
      { type: "setFlag", flag: "income", value: false },
      { type: "setFlag", flag: "transfer", value: false },
      { type: "setFlag", flag: "reportingExcluded", value: false },
      { type: "setFlag", flag: "reimbursement", value: false },
      { type: "requestReview", value: true },
    );
  } else if (kind === "debt" || kind === "investment") {
    actions.push(
      { type: "setFlag", flag: "transfer", value: false },
      { type: "setFlag", flag: "reportingExcluded", value: false },
      { type: "setFlag", flag: "income", value: false },
      { type: "setFlag", flag: "reimbursement", value: false },
    );
  }
  return actions;
}

function classificationFlagPatch(kind: CategoryKind | undefined, direction: "inflow" | "outflow") {
  if (kind === "income") {
    return {
      isTransfer: false,
      isExcluded: false,
      isIncome: direction === "inflow",
      isReimbursement: false,
    };
  }
  if (kind === "expense") {
    return {
      isTransfer: false,
      isExcluded: false,
      isIncome: false,
      isReimbursement: false,
    };
  }
  if (kind === "transfer") {
    return {
      isIncome: false,
      isTransfer: false,
      isExcluded: false,
      isReimbursement: false,
    };
  }
  if (kind === "debt" || kind === "investment") {
    return {
      isTransfer: false,
      isExcluded: false,
      isIncome: false,
      isReimbursement: false,
    };
  }
  return {};
}

function movementNeedsConfirmation(
  kind: CategoryKind | undefined,
  direction: "inflow" | "outflow",
) {
  return kind === "transfer" || (kind === "expense" && direction === "inflow");
}

function configuredAi(
  db: BetterWealthDatabase,
  config: AppConfig,
  householdId: string,
  userId: string,
) {
  const stored = db
    .select({ value: settings.value, isSecret: settings.isSecret })
    .from(settings)
    .where(
      and(
        eq(settings.householdId, householdId),
        eq(settings.scopeKey, userId),
        eq(settings.key, "integration.openrouter"),
      ),
    )
    .get();
  if (stored?.isSecret) {
    const wrapper = z.object({ encrypted: z.string() }).safeParse(stored.value);
    if (wrapper.success) {
      try {
        const plaintext = new FieldCipher(config.ENCRYPTION_KEY).decrypt(
          wrapper.data.encrypted,
          `settings:${householdId}:${userId}:openrouter`,
        );
        const parsed = aiSecretSchema.safeParse(JSON.parse(plaintext));
        if (parsed.success && parsed.data.enabled) return parsed.data;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function categorySlug(name: string) {
  return (
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "category"
  );
}

async function ensureVerifiedCategoryPath(input: {
  db: BetterWealthDatabase;
  householdId: string;
  proposal: {
    topLevelName: string;
    childName?: string | null;
    kind: CategoryKind;
  };
}) {
  const find = async (name: string, parentId: string | null) =>
    input.db
      .select({
        id: categories.id,
        name: categories.name,
        parentId: categories.parentId,
        kind: categories.kind,
      })
      .from(categories)
      .where(
        and(
          eq(categories.householdId, input.householdId),
          eq(categories.isActive, true),
          parentId ? eq(categories.parentId, parentId) : isNull(categories.parentId),
          sql`lower(trim(${categories.name})) = ${name.trim().toLowerCase()}`,
        ),
      )
      .get();
  const create = async (name: string, parentId: string | null) => {
    const id = ulid();
    const baseSlug = categorySlug(name);
    const slugExists = await input.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, input.householdId), eq(categories.slug, baseSlug)))
      .get();
    const row: ActiveCategoryRow = {
      id,
      name: name.trim(),
      parentId,
      kind: input.proposal.kind,
    };
    await input.db.insert(categories).values({
      ...row,
      householdId: input.householdId,
      slug: slugExists ? `${baseSlug}-${id.slice(-6).toLowerCase()}` : baseSlug,
      isActive: true,
      isSystem: false,
      sortOrder: 1_000,
    });
    return row;
  };
  const topName = input.proposal.topLevelName.trim();
  const existingTop = await find(topName, null);
  const top = existingTop ?? (await create(topName, null));
  const childName = input.proposal.childName?.trim();
  if (!childName || childName.toLowerCase() === top.name.trim().toLowerCase()) {
    return { category: top, path: [top.name], rows: [top], created: existingTop ? 0 : 1 };
  }
  const existingChild = await find(childName, top.id);
  const child = existingChild ?? (await create(childName, top.id));
  return {
    category: child,
    path: [top.name, child.name],
    rows: [top, child],
    created: Number(!existingTop) + Number(!existingChild),
  };
}

function asEngineRule(row: typeof rules.$inferSelect): CategorizationRule | undefined {
  const parsed = CategorizationRuleSchema.safeParse({
    id: row.id,
    name: row.name,
    priority: row.priority,
    enabled: row.isEnabled,
    origin: row.origin === "ai" ? "approvedAi" : row.origin,
    condition: row.conditions,
    actions: row.actions,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  return parsed.success ? parsed.data : undefined;
}

function asRuleTransaction(row: TransactionContext): RuleTransaction {
  return {
    id: row.transaction.id,
    rawDescription: row.transaction.rawDescription,
    normalizedDescription: row.transaction.normalizedDescription,
    ...(row.merchantName ? { merchant: row.merchantName } : {}),
    accountId: row.account.id,
    accountGroup: row.account.group,
    accountType: row.account.type,
    ...(row.account.institutionId ? { institutionId: row.account.institutionId } : {}),
    amount: money(row.transaction.amount, row.transaction.currency),
    date: row.transaction.transactedOn.slice(0, 10),
    status: row.transaction.status === "pending" ? "pending" : "posted",
    ...(row.transaction.recurringSeriesId
      ? { recurringSeriesId: row.transaction.recurringSeriesId }
      : {}),
    importSource: row.transaction.source,
    ...(row.transaction.categoryId ? { categoryId: row.transaction.categoryId } : {}),
    ...(row.transaction.note ? { note: row.transaction.note } : {}),
    tagIds: [],
  };
}

async function ensureMerchant(db: BetterWealthDatabase, householdId: string, merchantName: string) {
  const normalizedName = normalizeDescription(merchantName);
  const existing = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(
      and(eq(merchants.householdId, householdId), eq(merchants.normalizedName, normalizedName)),
    )
    .get();
  if (existing) return existing.id;
  const id = ulid();
  await db.insert(merchants).values({
    id,
    householdId,
    name: merchantName.trim().slice(0, 160),
    normalizedName,
  });
  return id;
}

async function applyEvaluation(
  db: BetterWealthDatabase,
  householdId: string,
  row: TransactionContext,
  engineRules: CategorizationRule[],
  preserveConfirmedRefund: boolean,
) {
  const evaluation = evaluateRules(asRuleTransaction(row), engineRules);
  if (!evaluation) return { matched: false, applied: false } as const;
  const patch = evaluation.patch;
  const merchantId = patch.merchant
    ? await ensureMerchant(db, householdId, patch.merchant)
    : undefined;
  const after = {
    categoryId: patch.categoryId ?? row.transaction.categoryId,
    categoryOrigin: patch.categoryId ? ("rule" as const) : row.transaction.categoryOrigin,
    envelopeId: patch.envelopeId ?? row.transaction.envelopeId,
    merchantId: merchantId ?? row.transaction.merchantId,
    recurringSeriesId: patch.recurringSeriesId ?? row.transaction.recurringSeriesId,
    isTransfer: preserveConfirmedRefund
      ? false
      : (patch.flags.transfer ?? row.transaction.isTransfer),
    isIncome: preserveConfirmedRefund ? false : (patch.flags.income ?? row.transaction.isIncome),
    isReimbursement: preserveConfirmedRefund
      ? true
      : (patch.flags.reimbursement ?? row.transaction.isReimbursement),
    isExcluded: preserveConfirmedRefund
      ? false
      : (patch.flags.reportingExcluded ?? row.transaction.isExcluded),
    note: patch.note ?? row.transaction.note,
    reviewState: patch.needsReview === true ? ("needs_review" as const) : ("none" as const),
  };
  const changed =
    after.categoryId !== row.transaction.categoryId ||
    after.categoryOrigin !== row.transaction.categoryOrigin ||
    after.envelopeId !== row.transaction.envelopeId ||
    after.merchantId !== row.transaction.merchantId ||
    after.recurringSeriesId !== row.transaction.recurringSeriesId ||
    after.isTransfer !== row.transaction.isTransfer ||
    after.isIncome !== row.transaction.isIncome ||
    after.isReimbursement !== row.transaction.isReimbursement ||
    after.isExcluded !== row.transaction.isExcluded ||
    after.note !== row.transaction.note ||
    after.reviewState !== row.transaction.reviewState;
  // A review-requesting rule intentionally leaves the transaction in the candidate queue. Once
  // its complete patch is present, treat the match as handled without inflating rule history.
  if (!changed) return { matched: true, applied: false } as const;
  const before = {
    categoryId: row.transaction.categoryId,
    envelopeId: row.transaction.envelopeId,
    merchantId: row.transaction.merchantId,
    reviewState: row.transaction.reviewState,
    flags: {
      transfer: row.transaction.isTransfer,
      income: row.transaction.isIncome,
      reimbursement: row.transaction.isReimbursement,
      reportingExcluded: row.transaction.isExcluded,
    },
  };
  const applied = db.transaction((transaction) => {
    const updated = transaction
      .update(transactions)
      .set({
        categoryId: after.categoryId,
        categoryOrigin: after.categoryOrigin,
        envelopeId: after.envelopeId,
        merchantId: after.merchantId,
        recurringSeriesId: after.recurringSeriesId,
        isTransfer: after.isTransfer,
        isIncome: after.isIncome,
        isReimbursement: after.isReimbursement,
        isExcluded: after.isExcluded,
        note: after.note,
        reviewState: after.reviewState,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(transactions.householdId, householdId),
          eq(transactions.id, row.transaction.id),
          eq(transactions.status, row.transaction.status),
          eq(transactions.reviewState, row.transaction.reviewState),
          eq(transactions.normalizedDescription, row.transaction.normalizedDescription),
          eq(transactions.amount, row.transaction.amount),
          isNull(transactions.userOverrideAt),
        ),
      )
      .returning({ id: transactions.id })
      .all();
    if (updated.length === 0) return false;
    transaction
      .insert(ruleRuns)
      .values({
        id: ulid(),
        householdId,
        transactionId: row.transaction.id,
        winningRuleId: evaluation.ruleId,
        competingRuleIds: [...evaluation.competingRuleIds],
        beforeSnapshot: before,
        afterSnapshot: JSON.parse(JSON.stringify(transactionRulePatchToJson(patch))) as Record<
          string,
          unknown
        >,
        explanation: evaluation.explanation,
      })
      .run();
    transaction
      .update(rules)
      .set({
        matchCount: sql`${rules.matchCount} + 1`,
        lastMatchedAt: new Date().toISOString(),
      })
      .where(and(eq(rules.householdId, householdId), eq(rules.id, evaluation.ruleId)))
      .run();
    return true;
  });
  return { matched: true, applied } as const;
}

function safeTextPattern(value: string | undefined): string | undefined {
  const cleaned = value?.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!cleaned || cleaned.length < 3 || cleaned.length > 120) return undefined;
  if ((cleaned.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 3) return undefined;
  return cleaned;
}

function actualDirection(transaction: RuleTransaction): "inflow" | "outflow" | "zero" {
  return transaction.amount.minorUnits > 0n
    ? "inflow"
    : transaction.amount.minorUnits < 0n
      ? "outflow"
      : "zero";
}

function exactDescriptionFallback(transaction: RuleTransaction): RuleCondition {
  const value = transaction.normalizedDescription.slice(0, 4_096);
  return {
    field: "normalizedDescription",
    operator: value === transaction.normalizedDescription ? "exact" : "startsWith",
    value,
    caseSensitive: false,
  };
}

/**
 * Generalizes a normalized description into a reusable `contains` pattern by dropping the first
 * order-ID-like token (letters+digits, 6+ chars, e.g. "BS8HH6UF0", "XXXXXXX6104") and everything
 * after it, plus trailing store numbers. Returns undefined when nothing can be generalized, so
 * callers can keep the exact description.
 */
function stableDescriptionPattern(normalized: string): string | undefined {
  const tokens = normalized.split(" ").filter(Boolean);
  const kept: string[] = [];
  for (const token of tokens) {
    if (token.length >= 6 && /[A-Z]/.test(token) && /\d/.test(token)) break;
    kept.push(token);
  }
  while (kept.length > 0 && /^\d+$/.test(kept[kept.length - 1] ?? "")) kept.pop();
  if (kept.length === tokens.length) return undefined;
  const pattern = kept.join(" ");
  return pattern.length >= 4 && /[A-Z]{2,}/.test(pattern) ? pattern : undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function deterministicRuleIdentity(rule: Pick<CategorizationRule, "condition" | "actions">) {
  return sha256(canonicalJson({ condition: rule.condition, actions: rule.actions }));
}

function providerFailureCode(error: unknown): string {
  return error instanceof AppError ? error.code : "ai_provider_failed";
}

function providerValidationReasons(error: unknown): string[] {
  if (!(error instanceof AppError)) return [];
  const details = error.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];
  const values = (details as { validationReason?: unknown }).validationReason;
  if (!Array.isArray(values)) return [];
  return values
    .slice(0, 8)
    .filter(
      (value): value is string =>
        typeof value === "string" && value.length <= 80 && /^[A-Za-z0-9_.-]+:[a-z_]+$/.test(value),
    );
}

function opensProviderCircuit(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  return (
    error.status === 401 ||
    error.status === 403 ||
    error.status === 429 ||
    error.code === "ai_auth_failed" ||
    error.code === "ai_rate_limited" ||
    error.code === "unsafe_url"
  );
}

async function persistInvalidAiAttempt(input: {
  db: BetterWealthDatabase;
  householdId: string;
  transactionId: string;
  fingerprint: string;
  model: string;
  code: string;
  validationReasons?: string[];
}) {
  const reasonSuffix = input.validationReasons?.length
    ? `: ${input.validationReasons.join(", ")}`
    : "";
  const rationale = `AI output rejected (${input.code}${reasonSuffix})`.slice(0, 280);
  await input.db
    .insert(aiSuggestions)
    .values({
      id: ulid(),
      householdId: input.householdId,
      transactionId: input.transactionId,
      inputFingerprint: input.fingerprint,
      confidenceBps: 0,
      rationale,
      status: "invalid",
      model: input.model,
    })
    .onConflictDoUpdate({
      target: [aiSuggestions.transactionId, aiSuggestions.inputFingerprint],
      set: { confidenceBps: 0, rationale, status: "invalid", model: input.model },
    });
}

export function buildAiRule(input: {
  id: string;
  transaction: RuleTransaction;
  suggestion: CategorizationSuggestion;
  categoryName?: string;
  categoryKind?: CategoryKind;
  updatedAt: string;
}): CategorizationRule {
  const proposed = input.suggestion.proposedRule;
  const merchantPattern = safeTextPattern(proposed?.merchantEquals ?? input.suggestion.merchant);
  const descriptionPattern = safeTextPattern(proposed?.descriptionContains);
  const normalizedTransaction = normalizeDescription(input.transaction.normalizedDescription);
  const currentMerchant = input.transaction.merchant
    ? normalizeDescription(input.transaction.merchant)
    : undefined;
  const normalizedMerchant = merchantPattern ? normalizeDescription(merchantPattern) : undefined;
  const usableDescriptionPattern = descriptionPattern
    ? normalizedTransaction.includes(normalizeDescription(descriptionPattern))
      ? (stableDescriptionPattern(normalizeDescription(descriptionPattern)) ?? descriptionPattern)
      : undefined
    : normalizedMerchant && normalizedTransaction.includes(normalizedMerchant)
      ? merchantPattern
      : undefined;
  const generalizedFallback = stableDescriptionPattern(normalizedTransaction);
  let usedExactFallback = false;
  const baseCondition: RuleCondition =
    merchantPattern && currentMerchant === normalizedMerchant
      ? { field: "merchant", operator: "exact", value: merchantPattern, caseSensitive: false }
      : usableDescriptionPattern
        ? {
            field: "normalizedDescription",
            operator: "contains",
            value: usableDescriptionPattern,
            caseSensitive: false,
          }
        : generalizedFallback
          ? {
              field: "normalizedDescription",
              operator: "contains",
              value: generalizedFallback,
              caseSensitive: false,
            }
          : (() => {
              usedExactFallback = true;
              return exactDescriptionFallback(input.transaction);
            })();
  const conditions: RuleCondition[] = [baseCondition];
  if (proposed?.direction && proposed.direction === actualDirection(input.transaction)) {
    conditions.push({ field: "direction", operator: "exact", value: proposed.direction });
  }
  // Prefix/merchant patterns cross the purchase/refund boundary (e.g. "AMAZON MKTPL" charges and
  // refunds share the prefix), so auto-minted rules always pin the direction they learned from —
  // unless the rule is already direction-bound or matches the full description exactly.
  const hasDirectionCondition = conditions.some(
    (condition) => "field" in condition && condition.field === "direction",
  );
  const direction = actualDirection(input.transaction);
  if (!usedExactFallback && !hasDirectionCondition && direction !== "zero") {
    conditions.push({ field: "direction", operator: "exact", value: direction });
  }
  if (proposed?.accountId === input.transaction.accountId) {
    conditions.push({
      field: "accountId",
      operator: "exact",
      value: proposed.accountId,
      caseSensitive: false,
    });
  }
  if (proposed?.minAmountMinor && proposed.maxAmountMinor) {
    const minimum = BigInt(proposed.minAmountMinor);
    const maximum = BigInt(proposed.maxAmountMinor);
    if (
      minimum <= maximum &&
      input.transaction.amount.minorUnits >= minimum &&
      input.transaction.amount.minorUnits <= maximum
    ) {
      conditions.push({
        field: "amount",
        operator: "between",
        minimum: minimum.toString(),
        maximum: maximum.toString(),
      });
    }
  }
  const proposedCondition: RuleCondition =
    conditions.length === 1
      ? (conditions[0] ?? exactDescriptionFallback(input.transaction))
      : { all: conditions };
  const condition = matchesRuleCondition(input.transaction, proposedCondition)
    ? proposedCondition
    : exactDescriptionFallback(input.transaction);
  const actions: RuleAction[] = [
    { type: "setCategory", categoryId: input.suggestion.categoryId },
    { type: "normalizeMerchant", merchant: input.suggestion.merchant },
    ...classificationFlagActions(
      input.categoryKind,
      input.transaction.amount.minorUnits >= 0n ? "inflow" : "outflow",
    ),
  ];
  return CategorizationRuleSchema.parse({
    id: input.id,
    name: `${input.suggestion.merchant} → ${input.categoryName ?? input.suggestion.categoryId}`,
    priority: 100,
    enabled: true,
    origin: "approvedAi",
    condition,
    actions,
    updatedAt: input.updatedAt,
  });
}

export async function categorizeHouseholdTransactions(input: {
  db: BetterWealthDatabase;
  config: AppConfig;
  householdId: string;
  userId: string;
  aiLimit?: number;
  aiRunDeadlineMs?: number;
  suggestCategory?: typeof suggestTransactionCategory;
  verifyCategory?: typeof verifyTransactionCategorization;
  attemptedFingerprints?: Set<string>;
  retryInvalidSuggestions?: boolean;
}) {
  const [ruleRows, categoryRows, candidates, confirmedRefundRows, exampleRows] = await Promise.all([
    input.db
      .select()
      .from(rules)
      .where(eq(rules.householdId, input.householdId))
      .orderBy(asc(rules.priority)),
    input.db
      .select({
        id: categories.id,
        name: categories.name,
        parentId: categories.parentId,
        kind: categories.kind,
      })
      .from(categories)
      .where(and(eq(categories.householdId, input.householdId), eq(categories.isActive, true)))
      .orderBy(asc(categories.id)),
    input.db
      .select({
        transaction: transactions,
        account: accounts,
        connectionOwnerUserId: connections.ownerUserId,
        merchantName: merchants.name,
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .leftJoin(
        connections,
        and(
          eq(connections.householdId, accounts.householdId),
          eq(connections.id, accounts.connectionId),
        ),
      )
      .leftJoin(merchants, eq(merchants.id, transactions.merchantId))
      .where(
        and(
          eq(transactions.householdId, input.householdId),
          eq(transactions.reviewState, "needs_review"),
          inArray(transactions.status, ["pending", "posted"]),
          eq(transactions.isTransfer, false),
          isNull(transactions.userOverrideAt),
        ),
      )
      .orderBy(asc(transactions.transactedOn))
      .limit(2_000),
    input.db
      .select({ transactionId: refundLinks.refundTransactionId })
      .from(refundLinks)
      .where(
        and(eq(refundLinks.householdId, input.householdId), eq(refundLinks.status, "confirmed")),
      ),
    input.db
      .select({
        merchantName: merchants.name,
        categoryId: transactions.categoryId,
        categoryOrigin: transactions.categoryOrigin,
        transactedOn: transactions.transactedOn,
      })
      .from(transactions)
      .innerJoin(merchants, eq(merchants.id, transactions.merchantId))
      .where(
        and(
          eq(transactions.householdId, input.householdId),
          inArray(transactions.categoryOrigin, ["user", "rule", "ai"]),
          sql`${transactions.categoryId} is not null`,
        ),
      )
      .orderBy(desc(transactions.transactedOn))
      .limit(200),
  ]);
  const confirmedRefundTransactionIds = new Set(
    confirmedRefundRows.map(({ transactionId }) => transactionId),
  );
  const previousSuggestionRows = await input.db
    .select({
      transactionId: aiSuggestions.transactionId,
      inputFingerprint: aiSuggestions.inputFingerprint,
      status: aiSuggestions.status,
    })
    .from(aiSuggestions)
    .where(eq(aiSuggestions.householdId, input.householdId));
  const attemptedFingerprints = input.attemptedFingerprints ?? new Set<string>();
  for (const row of previousSuggestionRows) {
    if (row.status !== "expired" && !(input.retryInvalidSuggestions && row.status === "invalid")) {
      attemptedFingerprints.add(row.inputFingerprint);
    }
  }
  const parkedAiTransactionIds = new Set(
    previousSuggestionRows
      .filter(({ status }) => status === "pending" || status === "accepted")
      .map(({ transactionId }) => transactionId),
  );
  const invalidAiTransactionIds = new Set(
    previousSuggestionRows
      .filter(({ status }) => status === "invalid")
      .map(({ transactionId }) => transactionId),
  );
  const orderedCandidates = input.retryInvalidSuggestions
    ? [...candidates].sort(
        (left, right) =>
          Number(invalidAiTransactionIds.has(left.transaction.id)) -
          Number(invalidAiTransactionIds.has(right.transaction.id)),
      )
    : candidates;
  const engineRules = ruleRows
    .map(asEngineRule)
    .filter((value): value is CategorizationRule => value !== undefined);
  const ai = configuredAi(input.db, input.config, input.householdId, input.userId);
  const parents = new Map(categoryRows.map(({ id, name }) => [id, name]));
  const categoryById = new Map(categoryRows.map((category) => [category.id, category]));
  const categoryPaths = new Map<string, string>();
  const categoryPath = (
    category: (typeof categoryRows)[number],
    seen = new Set<string>(),
  ): string => {
    const cached = categoryPaths.get(category.id);
    if (cached) return cached;
    if (!category.parentId || seen.has(category.id)) return category.name;
    const parent = categoryById.get(category.parentId);
    if (!parent) return category.name;
    const path = `${categoryPath(parent, new Set(seen).add(category.id))} / ${category.name}`;
    categoryPaths.set(category.id, path);
    return path;
  };
  const categoryPromptRows = categoryRows.map((category) => {
    const parentName = category.parentId ? parents.get(category.parentId) : undefined;
    return {
      id: category.id,
      name: category.name,
      path: categoryPath(category),
      ...(parentName ? { parentName } : {}),
    };
  });
  const existingAiRuleIdentities = new Set(
    engineRules
      .filter(({ origin }) => origin === "approvedAi")
      .map((rule) => deterministicRuleIdentity(rule)),
  );
  // Few-shot grounding: the model sees how this household already categorizes familiar
  // merchants (user-confirmed first, then rule/AI-applied), which keeps labels consistent
  // with local convention. Only merchant name + category id are disclosed.
  const exampleOriginRank = (origin: string) => (origin === "user" ? 0 : origin === "rule" ? 1 : 2);
  const merchantExamples: Array<{ merchant: string; categoryId: string }> = [];
  const exampleMerchantsSeen = new Set<string>();
  for (const row of [...exampleRows].sort(
    (left, right) =>
      exampleOriginRank(left.categoryOrigin) - exampleOriginRank(right.categoryOrigin) ||
      right.transactedOn.localeCompare(left.transactedOn),
  )) {
    if (!row.categoryId || !categoryById.has(row.categoryId)) continue;
    const key = normalizeDescription(row.merchantName);
    if (!key || exampleMerchantsSeen.has(key)) continue;
    exampleMerchantsSeen.add(key);
    merchantExamples.push({ merchant: row.merchantName.slice(0, 120), categoryId: row.categoryId });
    if (merchantExamples.length >= 12) break;
  }
  // Production runs always double-check the first pass with an independent recheck; unit tests
  // that inject only a first-pass double keep skipping verification.
  const verificationPlanned = !input.suggestCategory || Boolean(input.verifyCategory);
  // Learned per run: models that cannot execute the server-side web-search tool (MiniMax M3)
  // fail the tool attempt before the provider layer retries without it. Skipping the doomed
  // attempt for the rest of the run halves verification traffic and avoids the slow failure.
  let webResearchUsable = ai?.webResearchEnabled ?? false;
  let deterministic = 0;
  let aiAccepted = 0;
  let aiPending = 0;
  let aiFailed = 0;
  let aiCalls = 0;
  let aiVerificationCalls = 0;
  let aiVerificationFailed = 0;
  let aiVerified = 0;
  let aiResearchCitations = 0;
  let aiCreatedCategories = 0;
  const aiResearchHosts = new Set<string>();
  let aiPreviouslyAttempted = 0;
  let consecutiveProviderFailures = 0;
  let providerCircuitOpen = attemptedFingerprints.has(PROVIDER_CIRCUIT_SENTINEL);
  const requestedDeadline = input.aiRunDeadlineMs ?? AI_RUN_DEADLINE_MS;
  const deadlineMs = Number.isFinite(requestedDeadline)
    ? Math.min(AI_RUN_DEADLINE_MS, Math.max(1, requestedDeadline))
    : AI_RUN_DEADLINE_MS;
  const providerDeadline = Date.now() + deadlineMs;

  for (const row of orderedCandidates) {
    const deterministicResult = await applyEvaluation(
      input.db,
      input.householdId,
      row,
      engineRules,
      confirmedRefundTransactionIds.has(row.transaction.id),
    );
    if (deterministicResult.matched) {
      if (deterministicResult.applied) deterministic += 1;
      continue;
    }
    // A changing taxonomy intentionally changes the provider fingerprint, but it must not cause
    // the same unresolved transaction to accumulate duplicate suggestions across bounded batches.
    // Deterministic rules still run first so a newly approved pattern can resolve parked work.
    if (parkedAiTransactionIds.has(row.transaction.id)) {
      aiPreviouslyAttempted += 1;
      continue;
    }
    const disclosureScope = aiDisclosureScope(row, input.userId);
    if (
      !ai ||
      !disclosureScope ||
      providerCircuitOpen ||
      Date.now() >= providerDeadline ||
      aiCalls >= (input.aiLimit ?? 25) ||
      categoryRows.length === 0
    ) {
      continue;
    }
    const providerTransaction = {
      normalizedDescription: row.transaction.normalizedDescription,
      direction: row.transaction.amount >= 0n ? ("inflow" as const) : ("outflow" as const),
      amountBand: coarseAmountBand(row.transaction.amount),
      currency: row.transaction.currency,
      accountType: row.account.type,
    };
    const fingerprint = sha256(
      canonicalJson({
        disclosureScope,
        model: ai.model,
        verification: verificationPlanned
          ? ai.webResearchEnabled
            ? "openrouter-web-v2"
            : "self-recheck-v2"
          : "none",
        transaction: providerTransaction,
        categories: categoryPromptRows,
        examples: merchantExamples,
      }),
    );
    if (attemptedFingerprints.has(fingerprint)) {
      aiPreviouslyAttempted += 1;
      continue;
    }
    // Reserve the pattern before provider I/O. A timeout or rate-limit response must not make the
    // next bounded batch retry the same pattern during this invocation.
    attemptedFingerprints.add(fingerprint);
    aiCalls += 1;
    let suggestion: CategorizationSuggestion;
    try {
      suggestion = await (input.suggestCategory ?? suggestTransactionCategory)({
        apiKey: ai.apiKey,
        baseUrl: ai.baseUrl,
        model: ai.model,
        transaction: providerTransaction,
        categories: categoryPromptRows,
        examples: merchantExamples,
      });
      consecutiveProviderFailures = 0;
    } catch (error) {
      aiFailed += 1;
      consecutiveProviderFailures += 1;
      const code = providerFailureCode(error);
      if (code === "ai_invalid_response") {
        await persistInvalidAiAttempt({
          db: input.db,
          householdId: input.householdId,
          transactionId: row.transaction.id,
          fingerprint,
          model: ai.model,
          code,
          validationReasons: providerValidationReasons(error),
        });
      }
      const fatalProviderFailure = opensProviderCircuit(error);
      if (
        fatalProviderFailure ||
        consecutiveProviderFailures >= MAX_CONSECUTIVE_PROVIDER_FAILURES
      ) {
        providerCircuitOpen = true;
        if (fatalProviderFailure) attemptedFingerprints.add(PROVIDER_CIRCUIT_SENTINEL);
      }
      continue;
    }
    let selectedCategory = categoryById.get(suggestion.categoryId);
    if (verificationPlanned) {
      aiVerificationCalls += 1;
      try {
        const selectedPath = selectedCategory?.parentId
          ? `${parents.get(selectedCategory.parentId) ?? ""} / ${selectedCategory.name}`
          : selectedCategory?.name;
        const verified = await (input.verifyCategory ?? verifyTransactionCategorization)({
          apiKey: ai.apiKey,
          baseUrl: ai.baseUrl,
          model: ai.model,
          transaction: providerTransaction,
          categories: categoryPromptRows,
          examples: merchantExamples,
          previousSuggestion: {
            merchant: suggestion.merchant,
            categoryId: suggestion.categoryId,
            ...(selectedPath ? { categoryPath: selectedPath } : {}),
            confidence: suggestion.confidence,
            rationale: suggestion.rationale,
            ...(suggestion.proposedRule ? { proposedRule: suggestion.proposedRule } : {}),
          },
          allowCategoryProposal: true,
          allowWebResearch: webResearchUsable,
        });
        // A verification that fell back to a plain recheck proves the model cannot run the
        // web-search tool; stop attempting it for the rest of this run.
        if (webResearchUsable && !verified.research.requested) webResearchUsable = false;
        aiResearchCitations += verified.research.citationCount;
        for (const host of verified.research.citationHosts) aiResearchHosts.add(host);
        const verifiedRationale =
          `${verified.research.requested ? "Independent web-enabled recheck" : "Independent recheck"}: ${verified.rationale}`.slice(
            0,
            280,
          );
        if ("proposedCategory" in verified && verified.proposedCategory) {
          const proposedCategory = verified.proposedCategory;
          const materialized = await ensureVerifiedCategoryPath({
            db: input.db,
            householdId: input.householdId,
            proposal: {
              topLevelName: proposedCategory.topLevelName,
              kind: proposedCategory.kind,
              ...(proposedCategory.childName !== undefined
                ? { childName: proposedCategory.childName }
                : {}),
            },
          });
          aiCreatedCategories += materialized.created;
          selectedCategory = materialized.category;
          for (const category of materialized.rows) {
            if (categoryById.has(category.id)) continue;
            categoryRows.push(category);
            categoryById.set(category.id, category);
            parents.set(category.id, category.name);
            categoryPromptRows.push({
              id: category.id,
              name: category.name,
              path: category.parentId
                ? `${materialized.path[0]} / ${category.name}`
                : category.name,
              ...(category.parentId && materialized.path[0]
                ? { parentName: materialized.path[0] }
                : {}),
            });
          }
          suggestion = {
            merchant: verified.merchant,
            categoryId: materialized.category.id,
            confidence: verified.confidence,
            rationale: verifiedRationale,
            ...(verified.proposedRule ? { proposedRule: verified.proposedRule } : {}),
          };
        } else if (verified.categoryId) {
          suggestion = {
            merchant: verified.merchant,
            categoryId: verified.categoryId,
            confidence: verified.confidence,
            rationale: verifiedRationale,
            ...(verified.proposedRule ? { proposedRule: verified.proposedRule } : {}),
          };
          selectedCategory = categoryById.get(suggestion.categoryId);
        }
        aiVerified += 1;
        consecutiveProviderFailures = 0;
      } catch (error) {
        aiFailed += 1;
        aiVerificationFailed += 1;
        consecutiveProviderFailures += 1;
        const fatalProviderFailure = opensProviderCircuit(error);
        if (
          fatalProviderFailure ||
          consecutiveProviderFailures >= MAX_CONSECUTIVE_PROVIDER_FAILURES
        ) {
          providerCircuitOpen = true;
          if (fatalProviderFailure) attemptedFingerprints.add(PROVIDER_CIRCUIT_SENTINEL);
        }
        continue;
      }
    }
    if (!selectedCategory) {
      aiFailed += 1;
      consecutiveProviderFailures += 1;
      await persistInvalidAiAttempt({
        db: input.db,
        householdId: input.householdId,
        transactionId: row.transaction.id,
        fingerprint,
        model: ai.model,
        code: "ai_unknown_category",
      });
      if (consecutiveProviderFailures >= MAX_CONSECUTIVE_PROVIDER_FAILURES) {
        providerCircuitOpen = true;
      }
      continue;
    }
    const suggestionId = ulid();
    // Domain invariant the model cannot override: inflows into credit card/loan accounts are
    // payments, refunds, or transfers between the user's own accounts — never income. An
    // income label here (e.g. "PAYMENT THANK YOU") would silently inflate income reports, so
    // it always waits for a human decision regardless of confidence.
    const liabilityIncomeInflow =
      selectedCategory.kind === "income" && row.transaction.amount >= 0n && row.account.isLiability;
    const accepted = suggestion.confidence >= ai.confidenceThreshold && !liabilityIncomeInflow;
    if (!accepted) {
      await input.db
        .insert(aiSuggestions)
        .values({
          id: suggestionId,
          householdId: input.householdId,
          transactionId: row.transaction.id,
          inputFingerprint: fingerprint,
          suggestedMerchantName: suggestion.merchant,
          suggestedCategoryId: suggestion.categoryId,
          proposedRule: suggestion.proposedRule,
          confidenceBps: Math.round(suggestion.confidence * 10_000),
          rationale: suggestion.rationale,
          status: "pending",
          model: ai.model,
        })
        .onConflictDoUpdate({
          target: [aiSuggestions.transactionId, aiSuggestions.inputFingerprint],
          set: {
            suggestedMerchantName: suggestion.merchant,
            suggestedCategoryId: suggestion.categoryId,
            proposedRule: suggestion.proposedRule,
            confidenceBps: Math.round(suggestion.confidence * 10_000),
            rationale: suggestion.rationale,
            status: "pending",
            model: ai.model,
          },
        });
      aiPending += 1;
      continue;
    }
    const now = new Date().toISOString();
    const draftRule = buildAiRule({
      id: "ai-rule-draft",
      transaction: asRuleTransaction(row),
      suggestion,
      categoryName: selectedCategory.name,
      categoryKind: selectedCategory.kind,
      updatedAt: now,
    });
    const identity = deterministicRuleIdentity(draftRule);
    const aiRule: CategorizationRule = {
      ...draftRule,
      id: `ai_rule_${sha256(`${input.householdId}\u001f${identity}`).slice(0, 40)}`,
    };
    const shouldInsertRule = !existingAiRuleIdentities.has(identity);
    try {
      const committed = input.db.transaction((transaction) => {
        const normalizedMerchantName = normalizeDescription(suggestion.merchant);
        let merchantId = transaction
          .select({ id: merchants.id })
          .from(merchants)
          .where(
            and(
              eq(merchants.householdId, input.householdId),
              eq(merchants.normalizedName, normalizedMerchantName),
            ),
          )
          .get()?.id;
        if (!merchantId) {
          merchantId = ulid();
          transaction
            .insert(merchants)
            .values({
              id: merchantId,
              householdId: input.householdId,
              name: suggestion.merchant.trim().slice(0, 160),
              normalizedName: normalizedMerchantName,
            })
            .run();
        }

        let insertedRule = false;
        if (shouldInsertRule) {
          const inserted = transaction
            .insert(rules)
            .values({
              id: aiRule.id,
              householdId: input.householdId,
              name: aiRule.name,
              priority: aiRule.priority,
              isEnabled: true,
              origin: "ai",
              conditions: JSON.parse(JSON.stringify(aiRule.condition)) as Record<string, unknown>,
              actions: JSON.parse(JSON.stringify(aiRule.actions)) as Record<string, unknown>,
              specificityScore: ruleSpecificity(aiRule.condition),
              createdByUserId: input.userId,
            })
            .onConflictDoNothing()
            .returning({ id: rules.id })
            .all();
          insertedRule = inserted.length > 0;
        }

        const updated = transaction
          .update(transactions)
          .set({
            merchantId,
            categoryId: suggestion.categoryId,
            categoryOrigin: "ai",
            ...classificationFlagPatch(
              selectedCategory.kind,
              row.transaction.amount >= 0n ? "inflow" : "outflow",
            ),
            ...(confirmedRefundTransactionIds.has(row.transaction.id)
              ? {
                  isIncome: false,
                  isTransfer: false,
                  isExcluded: false,
                  isReimbursement: true,
                }
              : {}),
            reviewState: confirmedRefundTransactionIds.has(row.transaction.id)
              ? "none"
              : (selectedCategory.kind === "income" && row.transaction.amount < 0n) ||
                  movementNeedsConfirmation(
                    selectedCategory.kind,
                    row.transaction.amount >= 0n ? "inflow" : "outflow",
                  )
                ? "needs_review"
                : "none",
            updatedAt: now,
          })
          .where(
            and(
              eq(transactions.householdId, input.householdId),
              eq(transactions.id, row.transaction.id),
              eq(transactions.status, row.transaction.status),
              eq(transactions.reviewState, row.transaction.reviewState),
              eq(transactions.normalizedDescription, row.transaction.normalizedDescription),
              eq(transactions.amount, row.transaction.amount),
              isNull(transactions.userOverrideAt),
            ),
          )
          .returning({ id: transactions.id })
          .all();
        if (updated.length === 0) throw new EvaluatedTransactionChangedError();

        transaction
          .insert(aiSuggestions)
          .values({
            id: suggestionId,
            householdId: input.householdId,
            transactionId: row.transaction.id,
            inputFingerprint: fingerprint,
            suggestedMerchantName: suggestion.merchant,
            suggestedMerchantId: merchantId,
            suggestedCategoryId: suggestion.categoryId,
            proposedRule: suggestion.proposedRule,
            confidenceBps: Math.round(suggestion.confidence * 10_000),
            rationale: suggestion.rationale,
            status: "accepted",
            model: ai.model,
            reviewedByUserId: input.userId,
            reviewedAt: now,
          })
          .onConflictDoUpdate({
            target: [aiSuggestions.transactionId, aiSuggestions.inputFingerprint],
            set: {
              suggestedMerchantName: suggestion.merchant,
              suggestedMerchantId: merchantId,
              suggestedCategoryId: suggestion.categoryId,
              proposedRule: suggestion.proposedRule,
              confidenceBps: Math.round(suggestion.confidence * 10_000),
              rationale: suggestion.rationale,
              status: "accepted",
              model: ai.model,
              reviewedByUserId: input.userId,
              reviewedAt: now,
            },
          })
          .run();
        return { insertedRule };
      });
      if (committed.insertedRule) engineRules.push(aiRule);
      existingAiRuleIdentities.add(identity);
      aiAccepted += 1;
    } catch (error) {
      if (error instanceof EvaluatedTransactionChangedError) continue;
      throw error;
    }
  }
  if (aiVerificationCalls > 0) {
    await input.db.insert(auditEvents).values({
      id: ulid(),
      householdId: input.householdId,
      actorUserId: input.userId,
      actorType: "system",
      action: "ai.categorization_verified",
      entityType: "household",
      entityId: input.householdId,
      metadata: {
        model: ai?.model ?? null,
        verificationCalls: aiVerificationCalls,
        verified: aiVerified,
        failed: aiVerificationFailed,
        citationCount: aiResearchCitations,
        citationHosts: [...aiResearchHosts].sort(),
        createdCategories: aiCreatedCategories,
        accepted: aiAccepted,
        pending: aiPending,
        examplesProvided: merchantExamples.length,
      },
    });
  }
  return {
    candidates: candidates.length,
    deterministic,
    aiCalls,
    aiVerificationCalls,
    aiVerified,
    aiVerificationFailed,
    aiResearchCitations,
    aiResearchHosts: [...aiResearchHosts].sort(),
    aiCreatedCategories,
    aiAccepted,
    aiPending,
    aiFailed,
    aiPreviouslyAttempted,
  };
}
