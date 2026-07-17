import type { BetterWealthDatabase } from "@betterwealth/db";
import {
  accounts,
  aiSuggestions,
  categories,
  connections,
  merchants,
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
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";
import type { AppConfig } from "../config";
import {
  type CategorizationSuggestion,
  coarseAmountBand,
  suggestTransactionCategory,
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
});

type TransactionContext = {
  transaction: typeof transactions.$inferSelect;
  account: typeof accounts.$inferSelect;
  connectionOwnerUserId: string | null;
  merchantName: string | null;
};

type CategoryKind = "income" | "expense" | "transfer" | "debt" | "investment";

const AI_RUN_DEADLINE_MS = 120_000;
const MAX_CONSECUTIVE_PROVIDER_FAILURES = 3;
const PROVIDER_CIRCUIT_SENTINEL = "__betterwealth_ai_provider_circuit_open__";

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
      { type: "setFlag", flag: "reimbursement", value: direction === "inflow" },
    );
  } else if (kind === "transfer") {
    actions.push(
      { type: "setFlag", flag: "income", value: false },
      { type: "setFlag", flag: "transfer", value: true },
      { type: "setFlag", flag: "reportingExcluded", value: true },
      { type: "setFlag", flag: "reimbursement", value: false },
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
      isReimbursement: direction === "inflow",
    };
  }
  if (kind === "transfer") {
    return {
      isIncome: false,
      isTransfer: true,
      isExcluded: true,
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
    isTransfer: patch.flags.transfer ?? row.transaction.isTransfer,
    isIncome: patch.flags.income ?? row.transaction.isIncome,
    isReimbursement: patch.flags.reimbursement ?? row.transaction.isReimbursement,
    isExcluded: patch.flags.reportingExcluded ?? row.transaction.isExcluded,
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
}) {
  const rationale = `AI output rejected (${input.code})`.slice(0, 280);
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
      ? descriptionPattern
      : undefined
    : normalizedMerchant && normalizedTransaction.includes(normalizedMerchant)
      ? merchantPattern
      : undefined;
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
        : exactDescriptionFallback(input.transaction);
  const conditions: RuleCondition[] = [baseCondition];
  if (proposed?.direction && proposed.direction === actualDirection(input.transaction)) {
    conditions.push({ field: "direction", operator: "exact", value: proposed.direction });
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
  attemptedFingerprints?: Set<string>;
}) {
  const [ruleRows, categoryRows, candidates] = await Promise.all([
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
  ]);
  const previousSuggestionRows = await input.db
    .select({
      inputFingerprint: aiSuggestions.inputFingerprint,
      status: aiSuggestions.status,
    })
    .from(aiSuggestions)
    .where(eq(aiSuggestions.householdId, input.householdId));
  const attemptedFingerprints = input.attemptedFingerprints ?? new Set<string>();
  for (const row of previousSuggestionRows) {
    if (row.status !== "expired") attemptedFingerprints.add(row.inputFingerprint);
  }
  const engineRules = ruleRows
    .map(asEngineRule)
    .filter((value): value is CategorizationRule => value !== undefined);
  const ai = configuredAi(input.db, input.config, input.householdId, input.userId);
  const parents = new Map(categoryRows.map(({ id, name }) => [id, name]));
  const categoryById = new Map(categoryRows.map((category) => [category.id, category]));
  const categoryPromptRows = categoryRows.map((category) => {
    const parentName = category.parentId ? parents.get(category.parentId) : undefined;
    return {
      id: category.id,
      name: category.name,
      ...(parentName ? { parentName } : {}),
    };
  });
  const existingAiRuleIdentities = new Set(
    engineRules
      .filter(({ origin }) => origin === "approvedAi")
      .map((rule) => deterministicRuleIdentity(rule)),
  );
  let deterministic = 0;
  let aiAccepted = 0;
  let aiPending = 0;
  let aiFailed = 0;
  let aiCalls = 0;
  let aiPreviouslyAttempted = 0;
  let consecutiveProviderFailures = 0;
  let providerCircuitOpen = attemptedFingerprints.has(PROVIDER_CIRCUIT_SENTINEL);
  const requestedDeadline = input.aiRunDeadlineMs ?? AI_RUN_DEADLINE_MS;
  const deadlineMs = Number.isFinite(requestedDeadline)
    ? Math.min(AI_RUN_DEADLINE_MS, Math.max(1, requestedDeadline))
    : AI_RUN_DEADLINE_MS;
  const providerDeadline = Date.now() + deadlineMs;

  for (const row of candidates) {
    const deterministicResult = await applyEvaluation(
      input.db,
      input.householdId,
      row,
      engineRules,
    );
    if (deterministicResult.matched) {
      if (deterministicResult.applied) deterministic += 1;
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
        transaction: providerTransaction,
        categories: categoryPromptRows,
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
        });
      }
      if (
        opensProviderCircuit(error) ||
        consecutiveProviderFailures >= MAX_CONSECUTIVE_PROVIDER_FAILURES
      ) {
        providerCircuitOpen = true;
        attemptedFingerprints.add(PROVIDER_CIRCUIT_SENTINEL);
      }
      continue;
    }
    const selectedCategory = categoryById.get(suggestion.categoryId);
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
        attemptedFingerprints.add(PROVIDER_CIRCUIT_SENTINEL);
      }
      continue;
    }
    const suggestionId = ulid();
    const accepted = suggestion.confidence >= ai.confidenceThreshold;
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
            reviewState:
              selectedCategory.kind === "income" && row.transaction.amount < 0n
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
  return {
    candidates: candidates.length,
    deterministic,
    aiCalls,
    aiAccepted,
    aiPending,
    aiFailed,
    aiPreviouslyAttempted,
  };
}
