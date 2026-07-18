import type { BetterWealthDatabase } from "@betterwealth/db";
import {
  accounts,
  categories,
  envelopes,
  merchants,
  ruleRuns,
  rules,
  tags,
  transactionSplits,
  transactions,
  transactionTags,
} from "@betterwealth/db/schema";
import {
  type CategorizationRule,
  CategorizationRuleSchema,
  evaluateRules,
  money,
  RuleActionSchema,
  RuleConditionSchema,
  type RuleTransaction,
  ruleSpecificity,
  transactionRulePatchToJson,
} from "@betterwealth/shared";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import { requireCsrf } from "../../auth/middleware";
import type { AppConfig } from "../../config";
import { AppError, NotFoundError } from "../../lib/errors";
import { normalizeDescription } from "../../sync/reconcile";
import type { AppEnv } from "../../types";
import { dbJson, moneyJson, nowIso, page } from "./shared";

const ruleWriteSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    priority: z.number().int().min(-1_000_000).max(1_000_000).default(100),
    enabled: z.boolean().default(true),
    origin: z.literal("user").optional().default("user"),
    conditions: RuleConditionSchema.optional(),
    condition: RuleConditionSchema.optional(),
    actions: z.array(RuleActionSchema).min(1).max(50),
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.conditions && !input.condition) {
      context.addIssue({
        code: "custom",
        path: ["conditions"],
        message: "A rule condition is required",
      });
    }
    if (input.conditions && input.condition) {
      context.addIssue({
        code: "custom",
        path: ["condition"],
        message: "Use either condition or conditions, not both",
      });
    }
  });

const rulePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    enabled: z.boolean().optional(),
    conditions: RuleConditionSchema.optional(),
    condition: RuleConditionSchema.optional(),
    actions: z.array(RuleActionSchema).min(1).max(50).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (Object.keys(input).length === 0) {
      context.addIssue({ code: "custom", message: "At least one rule change is required" });
    }
    if (input.conditions && input.condition) {
      context.addIssue({
        code: "custom",
        path: ["condition"],
        message: "Use either condition or conditions, not both",
      });
    }
  });

type ParsedRuleCondition = z.infer<typeof RuleConditionSchema>;
type ParsedRuleAction = z.infer<typeof RuleActionSchema>;

function collectRuleReferenceIds(
  condition: ParsedRuleCondition,
  actions: readonly ParsedRuleAction[],
) {
  const accountIds = new Set<string>();
  const categoryIds = new Set<string>();
  const envelopeIds = new Set<string>();
  const tagIds = new Set<string>();

  const visit = (node: ParsedRuleCondition) => {
    if ("all" in node) {
      for (const child of node.all) visit(child);
      return;
    }
    if ("any" in node) {
      for (const child of node.any) visit(child);
      return;
    }
    if ("not" in node) {
      visit(node.not);
      return;
    }
    if (node.field === "accountId") {
      for (const value of typeof node.value === "string" ? [node.value] : node.value) {
        accountIds.add(value);
      }
    }
    if (node.field === "hasCategory" && node.categoryId) categoryIds.add(node.categoryId);
    if (node.field === "hasTag") tagIds.add(node.tagId);
  };
  visit(condition);

  for (const action of actions) {
    if (action.type === "setCategory") categoryIds.add(action.categoryId);
    if (action.type === "setEnvelope") envelopeIds.add(action.envelopeId);
    if (action.type === "addTags" || action.type === "removeTags") {
      for (const tagId of action.tagIds) tagIds.add(tagId);
    }
    if (action.type === "createFixedSplits" || action.type === "createPercentageSplits") {
      for (const split of action.splits) {
        categoryIds.add(split.categoryId);
        if (split.envelopeId) envelopeIds.add(split.envelopeId);
      }
    }
  }
  return { accountIds, categoryIds, envelopeIds, tagIds };
}

async function validateRuleReferences(
  db: BetterWealthDatabase,
  householdId: string,
  condition: ParsedRuleCondition,
  actions: readonly ParsedRuleAction[],
) {
  const references = collectRuleReferenceIds(condition, actions);
  const checks = [
    {
      label: "account",
      ids: references.accountIds,
      load: (ids: string[]) =>
        db
          .select({ id: accounts.id })
          .from(accounts)
          .where(and(eq(accounts.householdId, householdId), inArray(accounts.id, ids))),
    },
    {
      label: "category",
      ids: references.categoryIds,
      load: (ids: string[]) =>
        db
          .select({ id: categories.id })
          .from(categories)
          .where(and(eq(categories.householdId, householdId), inArray(categories.id, ids))),
    },
    {
      label: "envelope",
      ids: references.envelopeIds,
      load: (ids: string[]) =>
        db
          .select({ id: envelopes.id })
          .from(envelopes)
          .where(and(eq(envelopes.householdId, householdId), inArray(envelopes.id, ids))),
    },
    {
      label: "tag",
      ids: references.tagIds,
      load: (ids: string[]) =>
        db
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.householdId, householdId), inArray(tags.id, ids))),
    },
  ] as const;

  for (const check of checks) {
    const ids = [...check.ids];
    if (!ids.length) continue;
    const found = await check.load(ids);
    if (found.length !== ids.length) {
      throw new AppError(
        `Rule references an unavailable ${check.label}`,
        422,
        "invalid_rule_reference",
      );
    }
  }
}

function mapRuleOriginForWeb(origin: typeof rules.$inferSelect.origin) {
  return origin === "ai" ? ("approved_ai" as const) : origin;
}

function ruleDto(row: typeof rules.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    enabled: row.isEnabled,
    origin: mapRuleOriginForWeb(row.origin),
    conditions: row.conditions,
    condition: row.conditions,
    actions: row.actions,
    matchCount: row.matchCount,
    ...(row.lastMatchedAt ? { lastMatchedAt: row.lastMatchedAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function engineRule(row: typeof rules.$inferSelect): CategorizationRule {
  return CategorizationRuleSchema.parse({
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
}

type RuleTransactionRecord = {
  ruleTransaction: RuleTransaction;
  transaction: typeof transactions.$inferSelect;
  account: typeof accounts.$inferSelect;
  merchantName: string | null;
  tagIds: string[];
};

async function loadRuleTransactions(
  db: BetterWealthDatabase,
  householdId: string,
  transactionIds?: string[],
  maximum = 2_000,
): Promise<RuleTransactionRecord[]> {
  if (transactionIds?.length === 0) return [];
  const rows = await db
    .select({ transaction: transactions, account: accounts, merchantName: merchants.name })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(merchants, eq(merchants.id, transactions.merchantId))
    .where(
      and(
        eq(transactions.householdId, householdId),
        eq(accounts.householdId, householdId),
        transactionIds ? inArray(transactions.id, transactionIds) : undefined,
      ),
    )
    .orderBy(desc(transactions.transactedOn), desc(transactions.id))
    .limit(maximum);
  const ids = rows.map((row) => row.transaction.id);
  const tagRows = ids.length
    ? await db
        .select({ transactionId: transactionTags.transactionId, tagId: transactionTags.tagId })
        .from(transactionTags)
        .where(
          and(
            eq(transactionTags.householdId, householdId),
            inArray(transactionTags.transactionId, ids),
          ),
        )
    : [];
  const tagsByTransaction = new Map<string, string[]>();
  for (const tag of tagRows) {
    const values = tagsByTransaction.get(tag.transactionId) ?? [];
    values.push(tag.tagId);
    tagsByTransaction.set(tag.transactionId, values);
  }
  return rows.map(({ transaction, account, merchantName }) => {
    const tagIds = tagsByTransaction.get(transaction.id) ?? [];
    const ruleTransaction: RuleTransaction = {
      id: transaction.id,
      rawDescription: transaction.rawDescription,
      normalizedDescription: transaction.normalizedDescription,
      ...(merchantName ? { merchant: merchantName } : {}),
      accountId: account.id,
      accountGroup: account.group,
      accountType: account.type,
      ...(account.institutionId ? { institutionId: account.institutionId } : {}),
      amount: money(transaction.amount, transaction.currency),
      date: transaction.postedAt ?? transaction.authorizedAt ?? transaction.transactedOn,
      status: transaction.status === "pending" ? "pending" : "posted",
      ...(transaction.recurringSeriesId
        ? { recurringSeriesId: transaction.recurringSeriesId }
        : {}),
      importSource: transaction.source,
      ...(transaction.categoryId ? { categoryId: transaction.categoryId } : {}),
      tagIds,
      ...(transaction.note ? { note: transaction.note } : {}),
    };
    return { ruleTransaction, transaction, account, merchantName, tagIds };
  });
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
  await db.insert(merchants).values({ id, householdId, name: merchantName, normalizedName });
  return id;
}

export function createRuleRoutes(db: BetterWealthDatabase, config: AppConfig) {
  const routes = new Hono<AppEnv>();

  // Deterministic categorization rules ------------------------------------

  routes.get("/rules", async (context) => {
    const auth = context.get("auth");
    const rows = await db
      .select()
      .from(rules)
      .where(eq(rules.householdId, auth.householdId))
      .orderBy(desc(rules.priority), desc(rules.specificityScore), asc(rules.name));
    return context.json(page(rows.map(ruleDto)));
  });

  routes.post("/rules", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = ruleWriteSchema.parse(await context.req.json());
    const condition = input.conditions ?? input.condition!;
    await validateRuleReferences(db, auth.householdId, condition, input.actions);
    const id = ulid();
    await db.insert(rules).values({
      id,
      householdId: auth.householdId,
      name: input.name,
      priority: input.priority,
      isEnabled: input.enabled,
      origin: "user",
      conditions: dbJson(condition),
      actions: dbJson(input.actions),
      specificityScore: ruleSpecificity(condition),
      createdByUserId: auth.user.id,
    });
    const row = await db
      .select()
      .from(rules)
      .where(and(eq(rules.householdId, auth.householdId), eq(rules.id, id)))
      .get();
    return context.json(ruleDto(row!), 201);
  });

  routes.patch("/rules/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const current = await db
      .select()
      .from(rules)
      .where(and(eq(rules.householdId, auth.householdId), eq(rules.id, context.req.param("id"))))
      .get();
    if (!current) throw new NotFoundError("Rule");
    const input = rulePatchSchema.parse(await context.req.json());
    const condition = input.conditions ?? input.condition;
    if (current.origin === "system" && Object.keys(input).some((key) => key !== "enabled")) {
      throw new AppError(
        "System rules can be enabled or disabled, but their logic cannot be edited",
        409,
        "system_rule_read_only",
      );
    }
    const nextCondition = RuleConditionSchema.parse(condition ?? current.conditions);
    const nextActions = z.array(RuleActionSchema).parse(input.actions ?? current.actions);
    await validateRuleReferences(db, auth.householdId, nextCondition, nextActions);
    await db
      .update(rules)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.enabled === undefined ? {} : { isEnabled: input.enabled }),
        ...(condition === undefined
          ? {}
          : { conditions: dbJson(condition), specificityScore: ruleSpecificity(condition) }),
        ...(input.actions === undefined ? {} : { actions: dbJson(input.actions) }),
        updatedAt: nowIso(),
      })
      .where(and(eq(rules.householdId, auth.householdId), eq(rules.id, current.id)));
    const updated = await db
      .select()
      .from(rules)
      .where(and(eq(rules.householdId, auth.householdId), eq(rules.id, current.id)))
      .get();
    return context.json(ruleDto(updated!));
  });

  routes.delete("/rules/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const selected = await db
      .select({ id: rules.id, origin: rules.origin })
      .from(rules)
      .where(and(eq(rules.householdId, auth.householdId), eq(rules.id, context.req.param("id"))))
      .get();
    if (!selected) throw new NotFoundError("Rule");
    if (selected.origin === "system") {
      throw new AppError(
        "System rules can be disabled, but not deleted",
        409,
        "system_rule_read_only",
      );
    }
    db.transaction((transaction) => {
      transaction
        .update(ruleRuns)
        .set({ winningRuleId: null })
        .where(
          and(eq(ruleRuns.householdId, auth.householdId), eq(ruleRuns.winningRuleId, selected.id)),
        )
        .run();
      transaction
        .delete(rules)
        .where(and(eq(rules.householdId, auth.householdId), eq(rules.id, selected.id)))
        .run();
    });
    return context.body(null, 204);
  });

  routes.post("/rules/preview", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = z
      .object({
        name: z.string().trim().min(1).max(160).default("Rule preview"),
        priority: z.number().int().default(100),
        conditions: RuleConditionSchema.optional(),
        condition: RuleConditionSchema.optional(),
        actions: z.array(RuleActionSchema).min(1).max(50),
        transactionIds: z.array(z.string()).max(2_000).optional(),
        excludeRuleId: z.string().min(1).max(128).optional(),
      })
      .strict()
      .parse(await context.req.json());
    const condition = input.conditions ?? input.condition;
    if (!condition) throw new AppError("A rule condition is required", 422, "invalid_rule");
    await validateRuleReferences(db, auth.householdId, condition, input.actions);
    const candidate = CategorizationRuleSchema.parse({
      id: ulid(),
      name: input.name,
      priority: input.priority,
      enabled: true,
      origin: "user",
      condition,
      actions: input.actions,
      updatedAt: nowIso(),
    });
    const records = await loadRuleTransactions(db, auth.householdId, input.transactionIds, 2_000);
    const matching = records.filter((record) => evaluateRules(record.ruleTransaction, [candidate]));
    const currency = matching[0]?.transaction.currency ?? "USD";
    const aggregate = matching.reduce(
      (sum, record) =>
        record.transaction.currency === currency ? sum + record.transaction.amount : sum,
      0n,
    );
    const existing = (
      await db
        .select()
        .from(rules)
        .where(and(eq(rules.householdId, auth.householdId), eq(rules.isEnabled, true)))
    ).filter((rule) => rule.id !== input.excludeRuleId);
    const conflictIds = new Set<string>();
    for (const record of matching) {
      for (const rule of existing) {
        if (evaluateRules(record.ruleTransaction, [engineRule(rule)])) conflictIds.add(rule.id);
      }
    }
    return context.json({
      matchCount: matching.length,
      aggregateAmount: moneyJson(aggregate, currency),
      samples: matching.slice(0, 20).map((record) => ({
        id: record.transaction.id,
        effectiveDate:
          record.transaction.postedAt ??
          record.transaction.authorizedAt ??
          record.transaction.transactedOn,
        description: record.transaction.rawDescription,
        merchant: record.merchantName ?? record.transaction.normalizedDescription,
        amount: moneyJson(record.transaction.amount, record.transaction.currency),
        accountName: record.account.name,
        categoryName: "Preview",
        status: record.transaction.status === "pending" ? "pending" : "posted",
        reviewState: record.transaction.reviewState === "needs_review" ? "needs_review" : "ready",
        source: record.transaction.source === "provider" ? "simplefin" : record.transaction.source,
        tags: record.tagIds,
      })),
      conflicts: existing.filter((rule) => conflictIds.has(rule.id)).map(ruleDto),
    });
  });

  routes.post("/rules/:id/apply", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const selected = await db
      .select()
      .from(rules)
      .where(and(eq(rules.householdId, auth.householdId), eq(rules.id, context.req.param("id"))))
      .get();
    if (!selected) throw new NotFoundError("Rule");
    const input = z
      .object({ transactionIds: z.array(z.string()).min(1).max(2_000).optional() })
      .strict()
      .parse(await context.req.json().catch(() => ({})));
    const records = await loadRuleTransactions(db, auth.householdId, input.transactionIds, 2_000);
    const selectedEngineRule = engineRule(selected);
    await validateRuleReferences(
      db,
      auth.householdId,
      RuleConditionSchema.parse(selected.conditions),
      z.array(RuleActionSchema).parse(selected.actions),
    );
    const matches = records
      .map((record) => ({
        record,
        evaluation: evaluateRules(record.ruleTransaction, [selectedEngineRule]),
      }))
      .filter((item): item is typeof item & { evaluation: NonNullable<typeof item.evaluation> } =>
        Boolean(item.evaluation),
      );
    const tagIds = [...new Set(matches.flatMap(({ evaluation }) => evaluation.patch.tagIds))];
    if (tagIds.length) {
      const validTags = await db
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.householdId, auth.householdId), inArray(tags.id, tagIds)));
      if (validTags.length !== tagIds.length) {
        throw new AppError("Rule references an unavailable tag", 422, "invalid_rule_reference");
      }
    }
    const merchantIds = new Map<string, string>();
    for (const { evaluation } of matches) {
      if (evaluation.patch.merchant && !merchantIds.has(evaluation.patch.merchant)) {
        merchantIds.set(
          evaluation.patch.merchant,
          await ensureMerchant(db, auth.householdId, evaluation.patch.merchant),
        );
      }
    }
    const batchId = ulid();
    db.transaction((transaction) => {
      for (const { record, evaluation } of matches) {
        const patch = evaluation.patch;
        const merchantId = patch.merchant ? merchantIds.get(patch.merchant) : undefined;
        transaction
          .update(transactions)
          .set({
            ...(patch.categoryId
              ? { categoryId: patch.categoryId, categoryOrigin: "rule" as const }
              : {}),
            ...(patch.envelopeId ? { envelopeId: patch.envelopeId } : {}),
            ...(merchantId ? { merchantId } : {}),
            ...(patch.flags.transfer === undefined ? {} : { isTransfer: patch.flags.transfer }),
            ...(patch.flags.income === undefined ? {} : { isIncome: patch.flags.income }),
            ...(patch.flags.reimbursement === undefined
              ? {}
              : { isReimbursement: patch.flags.reimbursement }),
            ...(patch.flags.reportingExcluded === undefined
              ? {}
              : { isExcluded: patch.flags.reportingExcluded }),
            ...(patch.recurringSeriesId ? { recurringSeriesId: patch.recurringSeriesId } : {}),
            ...(patch.note === undefined ? {} : { note: patch.note }),
            ...(patch.needsReview === undefined
              ? {}
              : { reviewState: patch.needsReview ? ("needs_review" as const) : ("none" as const) }),
            updatedAt: nowIso(),
          })
          .where(
            and(
              eq(transactions.householdId, auth.householdId),
              eq(transactions.id, record.transaction.id),
            ),
          )
          .run();
        transaction
          .delete(transactionTags)
          .where(
            and(
              eq(transactionTags.householdId, auth.householdId),
              eq(transactionTags.transactionId, record.transaction.id),
            ),
          )
          .run();
        if (patch.tagIds.length) {
          transaction
            .insert(transactionTags)
            .values(
              patch.tagIds.map((tagId) => ({
                householdId: auth.householdId,
                transactionId: record.transaction.id,
                tagId,
              })),
            )
            .run();
        }
        if (patch.splits) {
          transaction
            .delete(transactionSplits)
            .where(
              and(
                eq(transactionSplits.householdId, auth.householdId),
                eq(transactionSplits.transactionId, record.transaction.id),
              ),
            )
            .run();
          transaction
            .insert(transactionSplits)
            .values(
              patch.splits.map((split, sequence) => ({
                id: ulid(),
                householdId: auth.householdId,
                transactionId: record.transaction.id,
                sequence,
                amount: split.amount.minorUnits,
                categoryId: split.categoryId,
                ...(split.envelopeId ? { envelopeId: split.envelopeId } : {}),
                ...(split.memo ? { memo: split.memo } : {}),
              })),
            )
            .run();
        }
        transaction
          .insert(ruleRuns)
          .values({
            id: ulid(),
            householdId: auth.householdId,
            transactionId: record.transaction.id,
            winningRuleId: selected.id,
            competingRuleIds: [],
            beforeSnapshot: dbJson({
              categoryId: record.transaction.categoryId,
              envelopeId: record.transaction.envelopeId,
              merchantId: record.transaction.merchantId,
              amountMinorUnits: record.transaction.amount.toString(),
              tagIds: record.tagIds,
            }),
            afterSnapshot: dbJson(transactionRulePatchToJson(patch)),
            explanation: evaluation.explanation,
            reversibleBatchId: batchId,
          })
          .run();
      }
      if (matches.length) {
        transaction
          .update(rules)
          .set({
            matchCount: selected.matchCount + matches.length,
            lastMatchedAt: nowIso(),
            updatedAt: nowIso(),
          })
          .where(and(eq(rules.householdId, auth.householdId), eq(rules.id, selected.id)))
          .run();
      }
    });
    return context.json({
      affected: matches.length,
      reversibleBatchId: batchId,
      transactionIds: matches.map(({ record }) => record.transaction.id),
    });
  });

  return routes;
}
