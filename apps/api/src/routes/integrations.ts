import type { BetterWealthDatabase } from "@betterwealth/db";
import { createHouseholdRepositories } from "@betterwealth/db";
import {
  accounts,
  aiSuggestions,
  categories,
  connections,
  jobs,
  merchants,
  rules,
  settings,
  syncRuns,
  transactions,
} from "@betterwealth/db/schema";
import { type RuleCondition, ruleSpecificity } from "@betterwealth/shared";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import { requireAuth, requireCsrf } from "../auth/middleware";
import type { AppConfig } from "../config";
import { coarseAmountBand, suggestTransactionCategory } from "../integrations/openrouter";
import { claimSimpleFinToken } from "../integrations/simplefin";
import { FieldCipher, sha256 } from "../lib/crypto";
import { ForbiddenError, NotFoundError } from "../lib/errors";
import { normalizeDescription } from "../sync/reconcile";
import type { AppEnv } from "../types";

const claimSchema = z.object({
  setupToken: z.string().trim().min(20).max(8_192),
  displayName: z.string().trim().min(1).max(100).default("SimpleFIN"),
});

const aiSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  consent: z.literal(true),
  baseUrl: z
    .string()
    .url()
    .max(2_048)
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    }, "AI provider URL must use HTTPS and cannot contain credentials"),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(10).max(2_000).optional(),
  confidenceThreshold: z.number().min(0).max(1).default(0.9),
});

type AiSettingsSecret = z.infer<typeof aiSettingsSchema> & { apiKey: string };

function aiSettingsAad(householdId: string, userId: string) {
  return `settings:${householdId}:${userId}:openrouter`;
}

function decodeAiSettings(
  cipher: FieldCipher,
  householdId: string,
  userId: string,
  value: unknown,
): AiSettingsSecret | undefined {
  const wrapper = z.object({ encrypted: z.string() }).safeParse(value);
  if (!wrapper.success) return undefined;
  try {
    const decrypted = cipher.decrypt(wrapper.data.encrypted, aiSettingsAad(householdId, userId));
    return aiSettingsSchema.extend({ apiKey: z.string().min(10) }).parse(JSON.parse(decrypted));
  } catch {
    return undefined;
  }
}

function publicConnection(connection: {
  id: string;
  provider: string;
  displayName: string;
  status: string;
  capabilities: string[];
  lastSuccessAt: string | null;
}) {
  return {
    id: connection.id,
    provider: connection.provider,
    displayName: connection.displayName,
    status:
      connection.status === "active"
        ? ("healthy" as const)
        : connection.status === "disabled"
          ? ("disabled" as const)
          : ("attention" as const),
    capabilities: connection.capabilities,
    lastSuccessfulAt: connection.lastSuccessAt ?? undefined,
    hasCredentials: true,
  };
}

export function createIntegrationRoutes(db: BetterWealthDatabase, config: AppConfig) {
  const routes = new Hono<AppEnv>();
  routes.use("*", requireAuth(db, config));

  routes.get("/connections", async (context) => {
    const auth = context.get("auth");
    const repositories = createHouseholdRepositories(db, auth.householdId);
    return context.json({
      data: repositories.connections
        .list()
        .map(({ encryptedCredentials: _secret, ...connection }) => publicConnection(connection)),
      page: { cursor: null, hasMore: false },
    });
  });

  routes.post("/connections/simplefin/claim", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = claimSchema.parse(await context.req.json());
    const accessUrl = await claimSimpleFinToken(input.setupToken);
    const connectionId = ulid();
    const aad = `connection:${connectionId}:credentials`;
    const cipher = new FieldCipher(config.ENCRYPTION_KEY);
    const repositories = createHouseholdRepositories(db, auth.householdId);
    const connection = repositories.connections.create({
      id: connectionId,
      ownerUserId: auth.user.id,
      provider: "simplefin",
      displayName: input.displayName,
      encryptedCredentials: cipher.encrypt(accessUrl, aad),
      credentialsAad: aad,
      capabilities: ["accounts", "balances", "transactions", "pending"],
      status: "active",
    });
    const jobId = ulid();
    await db.insert(jobs).values({
      id: jobId,
      householdId: auth.householdId,
      type: "simplefin.sync",
      payload: { connectionId, trigger: "initial" },
      state: "queued",
      scheduledAt: new Date().toISOString(),
      idempotencyKey: `${auth.user.id}:simplefin.initial:${connectionId}`,
    });
    const { encryptedCredentials: _secret, ...safeConnection } = connection;
    return context.json(
      {
        connection: publicConnection(safeConnection),
        sync: { syncRunId: jobId, state: "queued" as const },
      },
      201,
    );
  });

  routes.patch("/connections/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = z
      .object({
        displayName: z.string().trim().min(1).max(100).optional(),
        status: z.enum(["healthy", "attention", "disabled", "active", "degraded"]).optional(),
      })
      .strict()
      .parse(await context.req.json());
    const existing = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.householdId, auth.householdId),
          eq(connections.id, context.req.param("id")),
        ),
      )
      .get();
    if (!existing) throw new NotFoundError("Connection");
    if (existing.ownerUserId !== auth.user.id && auth.role !== "owner" && auth.role !== "admin") {
      throw new ForbiddenError(
        "Only the connection owner or a household administrator can edit it",
      );
    }
    const status =
      input.status === "healthy"
        ? ("active" as const)
        : input.status === "attention"
          ? ("degraded" as const)
          : input.status;
    const updated = await db
      .update(connections)
      .set({
        displayName: input.displayName,
        status,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(connections.householdId, auth.householdId), eq(connections.id, existing.id)))
      .returning()
      .get();
    if (!updated) throw new NotFoundError("Connection");
    return context.json(publicConnection(updated));
  });

  routes.post("/sync-runs", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const requested = z
      .object({ connectionId: z.string().optional() })
      .parse(await context.req.json().catch(() => ({})));
    const candidates = await db
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(
          eq(connections.householdId, auth.householdId),
          eq(connections.provider, "simplefin"),
          eq(connections.status, "active"),
          requested.connectionId ? eq(connections.id, requested.connectionId) : undefined,
        ),
      );
    if (candidates.length === 0) throw new NotFoundError("Active SimpleFIN connection");
    const suppliedKey = context.req.header("idempotency-key")?.trim();
    const queued: Array<{ id: string; state: typeof jobs.$inferSelect.state }> = [];
    for (const candidate of candidates) {
      const idempotencyKey = suppliedKey
        ? `${auth.user.id}:simplefin.sync:${candidate.id}:${suppliedKey.slice(0, 160)}`
        : undefined;
      if (idempotencyKey) {
        const existing = await db
          .select({ id: jobs.id, state: jobs.state })
          .from(jobs)
          .where(
            and(eq(jobs.householdId, auth.householdId), eq(jobs.idempotencyKey, idempotencyKey)),
          )
          .get();
        if (existing) {
          queued.push(existing);
          continue;
        }
      }
      const jobId = ulid();
      await db.insert(jobs).values({
        id: jobId,
        householdId: auth.householdId,
        type: "simplefin.sync",
        payload: { connectionId: candidate.id, trigger: "manual" },
        state: "queued",
        scheduledAt: new Date().toISOString(),
        idempotencyKey,
      });
      queued.push({ id: jobId, state: "queued" });
    }
    const first = queued[0];
    if (!first) throw new NotFoundError("Active SimpleFIN connection");
    return context.json(
      {
        syncRunId: first.id,
        syncRunIds: queued.map(({ id }) => id),
        state: queued.some(({ state }) => state === "queued") ? ("queued" as const) : first.state,
      },
      202,
    );
  });

  routes.get("/sync-runs", async (context) => {
    const auth = context.get("auth");
    const rows = await db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.householdId, auth.householdId))
      .orderBy(desc(syncRuns.createdAt))
      .limit(50);
    return context.json({ data: rows, page: { cursor: null, hasMore: false } });
  });

  routes.get("/settings/integrations/ai", async (context) => {
    const auth = context.get("auth");
    const repositories = createHouseholdRepositories(db, auth.householdId);
    const stored = repositories.settings.get("integration.openrouter", auth.user.id);
    if (!stored) {
      return context.json({
        configured: false,
        enabled: false,
        baseUrl: config.OPENROUTER_BASE_URL,
        model: config.BOOTSTRAP_OPENROUTER_MODEL,
        confidenceThreshold: 0.9,
      });
    }
    const decrypted = decodeAiSettings(
      new FieldCipher(config.ENCRYPTION_KEY),
      auth.householdId,
      auth.user.id,
      stored.value,
    );
    return context.json({
      configured: Boolean(decrypted),
      enabled: decrypted?.enabled ?? false,
      baseUrl: decrypted?.baseUrl ?? config.OPENROUTER_BASE_URL,
      model: decrypted?.model ?? config.BOOTSTRAP_OPENROUTER_MODEL,
      confidenceThreshold: decrypted?.confidenceThreshold ?? 0.9,
    });
  });

  routes.get("/settings/integrations", async (context) => {
    const auth = context.get("auth");
    const stored = createHouseholdRepositories(db, auth.householdId).settings.get(
      "integration.openrouter",
      auth.user.id,
    );
    const configured = stored
      ? decodeAiSettings(
          new FieldCipher(config.ENCRYPTION_KEY),
          auth.householdId,
          auth.user.id,
          stored.value,
        )
      : undefined;
    return context.json({
      ai: {
        enabled: configured?.enabled ?? false,
        provider: configured ? "openrouter" : null,
        model: configured?.model ?? config.BOOTSTRAP_OPENROUTER_MODEL ?? null,
        consentedFields: configured?.enabled
          ? [
              "normalized_description",
              "direction",
              "coarse_amount",
              "account_type",
              "allowed_categories",
              "limited_examples",
            ]
          : [],
      },
      exchangeRates: { provider: "manual", enabled: false },
      valuations: { providers: ["manual"] },
    });
  });

  routes.patch("/settings/integrations", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = z
      .object({
        ai: z
          .object({
            enabled: z.boolean(),
            provider: z.string().nullable().optional(),
            model: z.string().nullable().optional(),
            consentedFields: z.array(z.string()).optional(),
          })
          .optional(),
      })
      .passthrough()
      .parse(await context.req.json());
    if (input.ai) {
      const repositories = createHouseholdRepositories(db, auth.householdId);
      const previousStored = repositories.settings.get("integration.openrouter", auth.user.id);
      const cipher = new FieldCipher(config.ENCRYPTION_KEY);
      const previous = previousStored
        ? decodeAiSettings(cipher, auth.householdId, auth.user.id, previousStored.value)
        : undefined;
      const apiKey = previous?.apiKey ?? config.BOOTSTRAP_OPENROUTER_API_KEY;
      if (input.ai.enabled && !apiKey) throw new NotFoundError("AI API key");
      if (apiKey) {
        const secret: AiSettingsSecret = {
          enabled: input.ai.enabled,
          consent: true,
          baseUrl: previous?.baseUrl ?? config.OPENROUTER_BASE_URL,
          model: input.ai.model ?? previous?.model ?? config.BOOTSTRAP_OPENROUTER_MODEL,
          apiKey,
          confidenceThreshold: previous?.confidenceThreshold ?? 0.9,
        };
        const row = repositories.settings.set(
          previousStored?.id ?? ulid(),
          "integration.openrouter",
          {
            encrypted: cipher.encrypt(
              JSON.stringify(secret),
              aiSettingsAad(auth.householdId, auth.user.id),
            ),
          },
          auth.user.id,
        );
        await db.update(settings).set({ isSecret: true }).where(eq(settings.id, row.id));
      }
    }
    return context.json({ updated: true });
  });

  routes.put("/settings/integrations/ai", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = aiSettingsSchema.parse(await context.req.json());
    const repositories = createHouseholdRepositories(db, auth.householdId);
    const cipher = new FieldCipher(config.ENCRYPTION_KEY);
    const previousStored = repositories.settings.get("integration.openrouter", auth.user.id);
    const previous = previousStored
      ? decodeAiSettings(cipher, auth.householdId, auth.user.id, previousStored.value)
      : undefined;
    const apiKey = input.apiKey ?? previous?.apiKey;
    if (!apiKey) throw new NotFoundError("AI API key");
    const secret: AiSettingsSecret = { ...input, apiKey };
    const encrypted = cipher.encrypt(
      JSON.stringify(secret),
      aiSettingsAad(auth.householdId, auth.user.id),
    );
    const row = repositories.settings.set(
      previousStored?.id ?? ulid(),
      "integration.openrouter",
      { encrypted },
      auth.user.id,
    );
    await db.update(settings).set({ isSecret: true }).where(eq(settings.id, row.id));
    return context.json({
      configured: true,
      enabled: input.enabled,
      baseUrl: input.baseUrl,
      model: input.model,
      confidenceThreshold: input.confidenceThreshold,
    });
  });

  routes.post("/ai/suggestions/transactions/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const transaction = await db
      .select({ transaction: transactions, account: accounts })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(
        and(
          eq(transactions.householdId, auth.householdId),
          eq(transactions.id, context.req.param("id")),
        ),
      )
      .get();
    if (!transaction) throw new NotFoundError("Transaction");
    const categoryRows = await db
      .select({ id: categories.id, name: categories.name, parentId: categories.parentId })
      .from(categories)
      .where(and(eq(categories.householdId, auth.householdId), eq(categories.isActive, true)));
    const repositories = createHouseholdRepositories(db, auth.householdId);
    const stored = repositories.settings.get("integration.openrouter", auth.user.id);
    const cipher = new FieldCipher(config.ENCRYPTION_KEY);
    const configured = stored
      ? decodeAiSettings(cipher, auth.householdId, auth.user.id, stored.value)
      : config.BOOTSTRAP_OPENROUTER_API_KEY
        ? {
            enabled: true,
            consent: true as const,
            baseUrl: config.OPENROUTER_BASE_URL,
            model: config.BOOTSTRAP_OPENROUTER_MODEL,
            apiKey: config.BOOTSTRAP_OPENROUTER_API_KEY,
            confidenceThreshold: 0.9,
          }
        : undefined;
    if (!configured?.enabled) throw new NotFoundError("Enabled AI integration");
    const parentNames = new Map(categoryRows.map((category) => [category.id, category.name]));
    const suggestion = await suggestTransactionCategory({
      apiKey: configured.apiKey,
      baseUrl: configured.baseUrl,
      model: configured.model,
      transaction: {
        normalizedDescription: transaction.transaction.normalizedDescription,
        direction: transaction.transaction.amount >= 0n ? "inflow" : "outflow",
        amountBand: coarseAmountBand(transaction.transaction.amount),
        currency: transaction.transaction.currency,
        accountType: transaction.account.type,
      },
      categories: categoryRows.map((category) => {
        const parentName = category.parentId ? parentNames.get(category.parentId) : undefined;
        return {
          id: category.id,
          name: category.name,
          ...(parentName ? { parentName } : {}),
        };
      }),
    });
    const inputFingerprint = sha256(
      `${transaction.transaction.normalizedDescription}\u001f${transaction.transaction.amount}\u001f${categoryRows.map(({ id }) => id).join(",")}`,
    );
    const id = ulid();
    await db
      .insert(aiSuggestions)
      .values({
        id,
        householdId: auth.householdId,
        transactionId: transaction.transaction.id,
        inputFingerprint,
        suggestedMerchantName: suggestion.merchant,
        suggestedCategoryId: suggestion.categoryId,
        proposedRule: suggestion.proposedRule,
        confidenceBps: Math.round(suggestion.confidence * 10_000),
        rationale: suggestion.rationale,
        model: configured.model,
      })
      .onConflictDoUpdate({
        target: [aiSuggestions.transactionId, aiSuggestions.inputFingerprint],
        set: {
          suggestedMerchantName: suggestion.merchant,
          suggestedCategoryId: suggestion.categoryId,
          proposedRule: suggestion.proposedRule,
          confidenceBps: Math.round(suggestion.confidence * 10_000),
          rationale: suggestion.rationale,
          model: configured.model,
          status: "pending",
        },
      });
    return context.json({ id, ...suggestion }, 201);
  });

  routes.get("/ai/suggestions", async (context) => {
    const auth = context.get("auth");
    const rows = await db
      .select({
        suggestion: aiSuggestions,
        categoryName: categories.name,
        rawDescription: transactions.rawDescription,
        normalizedDescription: transactions.normalizedDescription,
        amount: transactions.amount,
        currency: transactions.currency,
      })
      .from(aiSuggestions)
      .innerJoin(transactions, eq(transactions.id, aiSuggestions.transactionId))
      .leftJoin(categories, eq(categories.id, aiSuggestions.suggestedCategoryId))
      .where(eq(aiSuggestions.householdId, auth.householdId))
      .orderBy(desc(aiSuggestions.createdAt))
      .limit(100);
    return context.json({
      data: rows
        .filter(({ suggestion }) => ["pending", "accepted", "rejected"].includes(suggestion.status))
        .map(
          ({
            suggestion,
            categoryName,
            rawDescription,
            normalizedDescription,
            amount,
            currency,
          }) => ({
            id: suggestion.id,
            transactionId: suggestion.transactionId,
            merchant: suggestion.suggestedMerchantName ?? normalizedDescription,
            categoryId: suggestion.suggestedCategoryId ?? "",
            categoryName: categoryName ?? "Uncategorized",
            confidence: suggestion.confidenceBps / 10_000,
            rationale: suggestion.rationale,
            amount: { minorUnits: amount.toString(), currency },
            rawDescription,
            proposedRule: suggestion.proposedRule,
            status: suggestion.status,
          }),
        ),
      page: { cursor: null, hasMore: false },
    });
  });

  routes.patch("/ai/suggestions/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = z
      .object({ status: z.enum(["accepted", "rejected"]), createRule: z.boolean().default(false) })
      .strict()
      .parse(await context.req.json());
    const row = await db
      .select({ suggestion: aiSuggestions, transaction: transactions })
      .from(aiSuggestions)
      .innerJoin(transactions, eq(transactions.id, aiSuggestions.transactionId))
      .where(
        and(
          eq(aiSuggestions.householdId, auth.householdId),
          eq(aiSuggestions.id, context.req.param("id")),
        ),
      )
      .get();
    if (!row) throw new NotFoundError("AI suggestion");
    const reviewedAt = new Date().toISOString();
    if (input.status === "accepted" && row.suggestion.suggestedCategoryId) {
      const merchantName =
        row.suggestion.suggestedMerchantName ?? row.transaction.normalizedDescription;
      const normalizedMerchant = normalizeDescription(merchantName);
      let merchant = await db
        .select({ id: merchants.id })
        .from(merchants)
        .where(
          and(
            eq(merchants.householdId, auth.householdId),
            eq(merchants.normalizedName, normalizedMerchant),
          ),
        )
        .get();
      if (!merchant) {
        merchant = { id: ulid() };
        await db.insert(merchants).values({
          id: merchant.id,
          householdId: auth.householdId,
          name: merchantName,
          normalizedName: normalizedMerchant,
        });
      }
      await db
        .update(transactions)
        .set({
          merchantId: merchant.id,
          categoryId: row.suggestion.suggestedCategoryId,
          categoryOrigin: "ai",
          reviewState: "reviewed",
          userOverrideAt: reviewedAt,
          updatedAt: reviewedAt,
        })
        .where(
          and(
            eq(transactions.householdId, auth.householdId),
            eq(transactions.id, row.transaction.id),
          ),
        );
      if (input.createRule) {
        const normalizedDescription = normalizeDescription(row.transaction.normalizedDescription);
        const pattern = normalizedDescription.includes(normalizedMerchant)
          ? merchantName
          : row.transaction.normalizedDescription;
        const condition: RuleCondition = normalizedDescription.includes(normalizedMerchant)
          ? {
              field: "normalizedDescription",
              operator: "contains",
              value: pattern,
              caseSensitive: false,
            }
          : {
              field: "normalizedDescription",
              operator: "exact",
              value: pattern,
              caseSensitive: false,
            };
        const name = `${merchantName} → ${row.suggestion.suggestedCategoryId}`;
        const existing = await db
          .select({ id: rules.id })
          .from(rules)
          .where(
            and(
              eq(rules.householdId, auth.householdId),
              eq(rules.name, name),
              eq(rules.origin, "ai"),
            ),
          )
          .get();
        if (!existing) {
          await db.insert(rules).values({
            id: ulid(),
            householdId: auth.householdId,
            name,
            priority: 100,
            origin: "ai",
            conditions: JSON.parse(JSON.stringify(condition)) as Record<string, unknown>,
            actions: JSON.parse(
              JSON.stringify([
                { type: "setCategory", categoryId: row.suggestion.suggestedCategoryId },
                { type: "normalizeMerchant", merchant: merchantName },
              ]),
            ) as Record<string, unknown>,
            specificityScore: ruleSpecificity(condition),
            createdByUserId: auth.user.id,
          });
        }
      }
    }
    await db
      .update(aiSuggestions)
      .set({
        status: input.status,
        reviewedByUserId: auth.user.id,
        reviewedAt,
      })
      .where(
        and(
          eq(aiSuggestions.householdId, auth.householdId),
          eq(aiSuggestions.id, row.suggestion.id),
        ),
      );
    return context.json({
      id: row.suggestion.id,
      transactionId: row.suggestion.transactionId,
      merchant: row.suggestion.suggestedMerchantName ?? row.transaction.normalizedDescription,
      categoryId: row.suggestion.suggestedCategoryId ?? "",
      confidence: row.suggestion.confidenceBps / 10_000,
      rationale: row.suggestion.rationale,
      proposedRule: row.suggestion.proposedRule,
      status: input.status,
    });
  });

  return routes;
}
