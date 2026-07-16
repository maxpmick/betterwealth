import type { BetterWealthDatabase } from "@betterwealth/db";
import {
  accounts,
  aiSuggestions,
  categories,
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
  money,
  type RuleAction,
  type RuleCondition,
  type RuleTransaction,
  ruleSpecificity,
  transactionRulePatchToJson,
} from "@betterwealth/shared";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";
import type { AppConfig } from "../config";
import {
  type CategorizationSuggestion,
  coarseAmountBand,
  suggestTransactionCategory,
} from "../integrations/openrouter";
import { FieldCipher, sha256 } from "../lib/crypto";
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
  merchantName: string | null;
};

function configuredAi(
  db: BetterWealthDatabase,
  config: AppConfig,
  householdId: string,
  userId: string,
) {
  const stored = db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.householdId, householdId),
        eq(settings.scopeKey, userId),
        eq(settings.key, "integration.openrouter"),
      ),
    )
    .get();
  if (stored) {
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
  return config.BOOTSTRAP_OPENROUTER_API_KEY
    ? {
        enabled: true,
        consent: true as const,
        baseUrl: config.OPENROUTER_BASE_URL,
        model: config.BOOTSTRAP_OPENROUTER_MODEL,
        apiKey: config.BOOTSTRAP_OPENROUTER_API_KEY,
        confidenceThreshold: 0.9,
      }
    : undefined;
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
  if (!evaluation) return false;
  const patch = evaluation.patch;
  const merchantId = patch.merchant
    ? await ensureMerchant(db, householdId, patch.merchant)
    : undefined;
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
  await db.transaction(async (transaction) => {
    await transaction
      .update(transactions)
      .set({
        categoryId: patch.categoryId,
        categoryOrigin: patch.categoryId ? "rule" : undefined,
        envelopeId: patch.envelopeId,
        merchantId,
        isTransfer: patch.flags.transfer,
        isIncome: patch.flags.income,
        isReimbursement: patch.flags.reimbursement,
        isExcluded: patch.flags.reportingExcluded,
        note: patch.note,
        reviewState: patch.needsReview === true ? "needs_review" : "none",
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(transactions.householdId, householdId),
          eq(transactions.id, row.transaction.id),
          isNull(transactions.userOverrideAt),
        ),
      );
    await transaction.insert(ruleRuns).values({
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
    });
    await transaction
      .update(rules)
      .set({
        matchCount: sql`${rules.matchCount} + 1`,
        lastMatchedAt: new Date().toISOString(),
      })
      .where(and(eq(rules.householdId, householdId), eq(rules.id, evaluation.ruleId)));
  });
  return true;
}

function safeTextPattern(value: string | undefined): string | undefined {
  const cleaned = value?.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!cleaned || cleaned.length < 3 || cleaned.length > 120) return undefined;
  if ((cleaned.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 3) return undefined;
  return cleaned;
}

export function buildAiRule(input: {
  id: string;
  transaction: RuleTransaction;
  suggestion: CategorizationSuggestion;
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
        : {
            field: "normalizedDescription",
            operator: "exact",
            value: input.transaction.normalizedDescription.slice(0, 4_096),
            caseSensitive: false,
          };
  const conditions: RuleCondition[] = [baseCondition];
  if (proposed?.direction) {
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
    if (minimum <= maximum) {
      conditions.push({
        field: "amount",
        operator: "between",
        minimum: minimum.toString(),
        maximum: maximum.toString(),
      });
    }
  }
  const condition: RuleCondition = conditions.length === 1 ? conditions[0]! : { all: conditions };
  const actions: RuleAction[] = [
    { type: "setCategory", categoryId: input.suggestion.categoryId },
    { type: "normalizeMerchant", merchant: input.suggestion.merchant },
  ];
  return CategorizationRuleSchema.parse({
    id: input.id,
    name: `${input.suggestion.merchant} → ${input.suggestion.categoryId}`,
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
  suggestCategory?: typeof suggestTransactionCategory;
}) {
  const [ruleRows, categoryRows, candidates] = await Promise.all([
    input.db
      .select()
      .from(rules)
      .where(and(eq(rules.householdId, input.householdId), eq(rules.isEnabled, true)))
      .orderBy(asc(rules.priority)),
    input.db
      .select({ id: categories.id, name: categories.name, parentId: categories.parentId })
      .from(categories)
      .where(and(eq(categories.householdId, input.householdId), eq(categories.isActive, true))),
    input.db
      .select({
        transaction: transactions,
        account: accounts,
        merchantName: merchants.name,
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .leftJoin(merchants, eq(merchants.id, transactions.merchantId))
      .where(
        and(
          eq(transactions.householdId, input.householdId),
          eq(transactions.reviewState, "needs_review"),
          eq(transactions.isTransfer, false),
          isNull(transactions.userOverrideAt),
        ),
      )
      .orderBy(asc(transactions.transactedOn))
      .limit(250),
  ]);
  const engineRules = ruleRows
    .map(asEngineRule)
    .filter((value): value is CategorizationRule => value !== undefined);
  const ai = configuredAi(input.db, input.config, input.householdId, input.userId);
  const parents = new Map(categoryRows.map(({ id, name }) => [id, name]));
  const categoryById = new Map(categoryRows.map((category) => [category.id, category]));
  let deterministic = 0;
  let aiAccepted = 0;
  let aiPending = 0;
  let aiFailed = 0;
  let aiCalls = 0;

  for (const row of candidates) {
    if (await applyEvaluation(input.db, input.householdId, row, engineRules)) {
      deterministic += 1;
      continue;
    }
    if (!ai || aiCalls >= (input.aiLimit ?? 25) || categoryRows.length === 0) continue;
    aiCalls += 1;
    try {
      const suggestion = await (input.suggestCategory ?? suggestTransactionCategory)({
        apiKey: ai.apiKey,
        baseUrl: ai.baseUrl,
        model: ai.model,
        transaction: {
          normalizedDescription: row.transaction.normalizedDescription,
          direction: row.transaction.amount >= 0n ? "inflow" : "outflow",
          amountBand: coarseAmountBand(row.transaction.amount),
          currency: row.transaction.currency,
          accountType: row.account.type,
        },
        categories: categoryRows.map((category) => ({
          id: category.id,
          name: category.name,
          ...(category.parentId && parents.get(category.parentId)
            ? { parentName: parents.get(category.parentId)! }
            : {}),
        })),
      });
      const fingerprint = sha256(
        `${row.transaction.normalizedDescription}\u001f${row.transaction.amount < 0n ? "outflow" : "inflow"}\u001f${row.account.type}\u001f${categoryRows.map(({ id }) => id).join(",")}`,
      );
      const suggestionId = ulid();
      const accepted = suggestion.confidence >= ai.confidenceThreshold;
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
          status: accepted ? "accepted" : "pending",
          model: ai.model,
          reviewedAt: accepted ? new Date().toISOString() : undefined,
        })
        .onConflictDoUpdate({
          target: [aiSuggestions.transactionId, aiSuggestions.inputFingerprint],
          set: {
            suggestedMerchantName: suggestion.merchant,
            suggestedCategoryId: suggestion.categoryId,
            proposedRule: suggestion.proposedRule,
            confidenceBps: Math.round(suggestion.confidence * 10_000),
            rationale: suggestion.rationale,
            status: accepted ? "accepted" : "pending",
            model: ai.model,
          },
        });
      if (!accepted) {
        aiPending += 1;
        continue;
      }
      const merchantId = await ensureMerchant(input.db, input.householdId, suggestion.merchant);
      const now = new Date().toISOString();
      const aiRule = buildAiRule({
        id: ulid(),
        transaction: asRuleTransaction(row),
        suggestion,
        updatedAt: now,
      });
      const existingRule = await input.db
        .select({ id: rules.id })
        .from(rules)
        .where(
          and(
            eq(rules.householdId, input.householdId),
            eq(rules.name, aiRule.name),
            eq(rules.origin, "ai"),
          ),
        )
        .get();
      if (!existingRule) {
        await input.db.insert(rules).values({
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
        });
        engineRules.push(aiRule);
      }
      await input.db
        .update(transactions)
        .set({
          merchantId,
          categoryId: suggestion.categoryId,
          categoryOrigin: "ai",
          reviewState: "none",
          updatedAt: now,
        })
        .where(
          and(
            eq(transactions.householdId, input.householdId),
            eq(transactions.id, row.transaction.id),
            isNull(transactions.userOverrideAt),
          ),
        );
      if (!categoryById.has(suggestion.categoryId)) throw new Error("Unknown AI category");
      aiAccepted += 1;
    } catch {
      aiFailed += 1;
    }
  }
  return {
    candidates: candidates.length,
    deterministic,
    aiCalls,
    aiAccepted,
    aiPending,
    aiFailed,
  };
}
