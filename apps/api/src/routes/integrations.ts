import type { BetterWealthDatabase } from "@betterwealth/db";
import { createHouseholdRepositories } from "@betterwealth/db";
import {
  accounts,
  aiSuggestions,
  auditEvents,
  categories,
  connections,
  jobs,
  merchants,
  rules,
  settings,
  syncRuns,
  transactions,
} from "@betterwealth/db/schema";
import { money, ruleSpecificity } from "@betterwealth/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import { requireAuth, requireCsrf } from "../auth/middleware";
import { buildAiRule } from "../categorization/service";
import type { AppConfig } from "../config";
import {
  assertTrustedAiBaseUrl,
  coarseAmountBand,
  type ProposedCategoryPath,
  regenerateTransactionCategory,
  suggestTransactionCategory,
} from "../integrations/openrouter";
import { claimSimpleFinToken } from "../integrations/simplefin";
import { FieldCipher, sha256 } from "../lib/crypto";
import { AppError, ForbiddenError, NotFoundError } from "../lib/errors";
import { idempotency } from "../lib/idempotency";
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
  webResearchEnabled: z.boolean().default(false),
});

type AiSettingsSecret = z.infer<typeof aiSettingsSchema> & { apiKey: string };

export type IntegrationRouteDependencies = {
  regenerateTransactionCategory?: typeof regenerateTransactionCategory;
};

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

type CategoryPromptRow = {
  id: string;
  name: string;
  parentId: string | null;
  kind: "income" | "expense" | "transfer" | "debt" | "investment";
  slug: string;
};

function normalizedTaxonomyName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function taxonomySlug(value: string) {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "category"
  );
}

function categoryPathMap(rows: CategoryPromptRow[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const memo = new Map<string, string>();
  const visit = (row: CategoryPromptRow, seen = new Set<string>()): string => {
    const cached = memo.get(row.id);
    if (cached) return cached;
    if (!row.parentId || seen.has(row.id)) return row.name;
    const parent = byId.get(row.parentId);
    if (!parent) return row.name;
    const next = new Set(seen).add(row.id);
    const path = `${visit(parent, next)} / ${row.name}`;
    memo.set(row.id, path);
    return path;
  };
  for (const row of rows) memo.set(row.id, visit(row));
  return memo;
}

function categoryDisclosures(rows: CategoryPromptRow[]) {
  const paths = categoryPathMap(rows);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return rows.map((row) => {
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    return {
      id: row.id,
      name: row.name,
      path: paths.get(row.id) ?? row.name,
      ...(parent ? { parentName: parent.name } : {}),
    };
  });
}

function configuredAiForUser(
  db: BetterWealthDatabase,
  config: AppConfig,
  householdId: string,
  userId: string,
) {
  const stored = createHouseholdRepositories(db, householdId).settings.get(
    "integration.openrouter",
    userId,
  );
  return stored
    ? decodeAiSettings(new FieldCipher(config.ENCRYPTION_KEY), householdId, userId, stored.value)
    : undefined;
}

function materializeCategoryProposal(
  db: BetterWealthDatabase,
  householdId: string,
  proposal: ProposedCategoryPath,
) {
  return db.transaction((transaction) => {
    const rows = transaction
      .select({
        id: categories.id,
        name: categories.name,
        parentId: categories.parentId,
        kind: categories.kind,
        slug: categories.slug,
        isActive: categories.isActive,
        sortOrder: categories.sortOrder,
      })
      .from(categories)
      .where(eq(categories.householdId, householdId))
      .all();
    const createdCategoryIds: string[] = [];
    const slugs = new Set(rows.map(({ slug }) => slug));
    const nextSortOrder = () =>
      Math.max(0, ...rows.map(({ sortOrder }) => sortOrder), rows.length) +
      createdCategoryIds.length +
      1;
    const uniqueSlug = (name: string, id: string) => {
      const base = taxonomySlug(name);
      const slug = slugs.has(base) ? `${base}-${id.slice(-6).toLowerCase()}` : base;
      slugs.add(slug);
      return slug;
    };
    const reactivate = (row: (typeof rows)[number]) => {
      if (!row.isActive) {
        transaction
          .update(categories)
          .set({ isActive: true, updatedAt: new Date().toISOString() })
          .where(and(eq(categories.householdId, householdId), eq(categories.id, row.id)))
          .run();
      }
      return row;
    };
    const insert = (name: string, parentId: string | null, kind: ProposedCategoryPath["kind"]) => {
      const id = ulid();
      const row = {
        id,
        name,
        parentId,
        kind,
        slug: uniqueSlug(name, id),
        isActive: true,
        sortOrder: nextSortOrder(),
      };
      transaction
        .insert(categories)
        .values({ ...row, householdId, isSystem: false })
        .run();
      rows.push(row);
      createdCategoryIds.push(id);
      return row;
    };

    const topLevelName = proposal.topLevelName.trim().replace(/\s+/g, " ");
    const topLevelKey = normalizedTaxonomyName(topLevelName);
    const childName = proposal.childName?.trim().replace(/\s+/g, " ") || null;
    if (!childName) {
      const existing =
        rows.find(
          (row) => row.parentId === null && normalizedTaxonomyName(row.name) === topLevelKey,
        ) ?? rows.find((row) => normalizedTaxonomyName(row.name) === topLevelKey);
      const category = existing ? reactivate(existing) : insert(topLevelName, null, proposal.kind);
      const paths = categoryPathMap(rows);
      return {
        categoryId: category.id,
        categoryName: category.name,
        categoryPath: paths.get(category.id) ?? category.name,
        createdCategoryIds,
      };
    }

    let parent = rows.find(
      (row) => row.parentId === null && normalizedTaxonomyName(row.name) === topLevelKey,
    );
    parent = parent ? reactivate(parent) : insert(topLevelName, null, proposal.kind);
    if (normalizedTaxonomyName(childName) === normalizedTaxonomyName(parent.name)) {
      return {
        categoryId: parent.id,
        categoryName: parent.name,
        categoryPath: parent.name,
        createdCategoryIds,
      };
    }
    const childKey = normalizedTaxonomyName(childName);
    const existingChild = rows.find(
      (row) => row.parentId === parent?.id && normalizedTaxonomyName(row.name) === childKey,
    );
    const child = existingChild
      ? reactivate(existingChild)
      : insert(childName, parent.id, parent.kind);
    return {
      categoryId: child.id,
      categoryName: child.name,
      categoryPath: `${parent.name} / ${child.name}`,
      createdCategoryIds,
    };
  });
}

export function createIntegrationRoutes(
  db: BetterWealthDatabase,
  config: AppConfig,
  dependencies: IntegrationRouteDependencies = {},
) {
  const routes = new Hono<AppEnv>();
  const regenerateCategory =
    dependencies.regenerateTransactionCategory ?? regenerateTransactionCategory;
  routes.use("*", requireAuth(db, config));
  routes.use("*", idempotency(db));

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
          inArray(connections.status, ["active", "degraded"]),
          requested.connectionId ? eq(connections.id, requested.connectionId) : undefined,
        ),
      );
    if (candidates.length === 0) throw new NotFoundError("Retryable SimpleFIN connection");
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
        webResearchEnabled: false,
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
      webResearchEnabled: decrypted?.webResearchEnabled ?? false,
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
              ...(configured.webResearchEnabled ? ["public_merchant_web_search"] : []),
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
      if (input.ai.enabled && !input.ai.consentedFields?.length) {
        // Enabling AI records disclosure consent, so the request must carry the
        // explicit field list the user agreed to — never imply it server-side.
        throw new AppError(
          "Enabling AI requires an explicit consentedFields list",
          400,
          "ai_consent_required",
        );
      }
      const repositories = createHouseholdRepositories(db, auth.householdId);
      const previousStored = repositories.settings.get("integration.openrouter", auth.user.id);
      const cipher = new FieldCipher(config.ENCRYPTION_KEY);
      const previous = previousStored
        ? decodeAiSettings(cipher, auth.householdId, auth.user.id, previousStored.value)
        : undefined;
      // Only a key the user configured themselves (via PUT) may back the toggle —
      // the server bootstrap key is not per-user consent.
      const apiKey = previous?.apiKey;
      if (input.ai.enabled && !apiKey) throw new NotFoundError("AI API key");
      if (apiKey) {
        const secret: AiSettingsSecret = {
          enabled: input.ai.enabled,
          consent: true,
          baseUrl: previous?.baseUrl ?? config.OPENROUTER_BASE_URL,
          model: input.ai.model ?? previous?.model ?? config.BOOTSTRAP_OPENROUTER_MODEL,
          apiKey,
          confidenceThreshold: previous?.confidenceThreshold ?? 0.9,
          webResearchEnabled: previous?.webResearchEnabled ?? false,
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
    assertTrustedAiBaseUrl(input.baseUrl);
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
      webResearchEnabled: input.webResearchEnabled,
    });
  });

  routes.post("/ai/suggestions/transactions/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const transaction = await db
      .select({
        transaction: transactions,
        account: accounts,
        connectionOwnerUserId: connections.ownerUserId,
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .leftJoin(connections, eq(connections.id, accounts.connectionId))
      .where(
        and(
          eq(transactions.householdId, auth.householdId),
          eq(transactions.id, context.req.param("id")),
        ),
      )
      .get();
    if (!transaction) throw new NotFoundError("Transaction");
    const disclosureOwners = new Set(
      [transaction.account.ownerUserId, transaction.connectionOwnerUserId].filter(
        (owner): owner is string => Boolean(owner),
      ),
    );
    if (disclosureOwners.size !== 1 || !disclosureOwners.has(auth.user.id)) {
      // Fail closed like the batch and regenerate paths: do not disclose whether
      // another household member owns the underlying transaction.
      throw new NotFoundError("Transaction");
    }
    const categoryRows = await db
      .select({
        id: categories.id,
        name: categories.name,
        parentId: categories.parentId,
        kind: categories.kind,
        slug: categories.slug,
      })
      .from(categories)
      .where(and(eq(categories.householdId, auth.householdId), eq(categories.isActive, true)));
    // Per-user settings only — a bootstrap server key is not disclosure consent
    // (same source as the regenerate route).
    const configured = configuredAiForUser(db, config, auth.householdId, auth.user.id);
    if (!configured?.enabled) throw new NotFoundError("Enabled AI integration");
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
      categories: categoryDisclosures(categoryRows),
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
    const [rows, taxonomy] = await Promise.all([
      db
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
        .limit(1_000),
      db
        .select({
          id: categories.id,
          name: categories.name,
          parentId: categories.parentId,
          kind: categories.kind,
          slug: categories.slug,
        })
        .from(categories)
        .where(eq(categories.householdId, auth.householdId)),
    ]);
    const taxonomyPaths = categoryPathMap(taxonomy);
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
            categoryPath: suggestion.suggestedCategoryId
              ? (
                  taxonomyPaths.get(suggestion.suggestedCategoryId) ??
                  categoryName ??
                  "Uncategorized"
                ).split(" / ")
              : [],
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

  routes.post("/ai/suggestions/:id/regenerate", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = z
      .object({
        feedback: z.string().trim().min(3).max(800),
        allowWebResearch: z.boolean().optional(),
      })
      .strict()
      .parse(await context.req.json());
    const row = await db
      .select({
        suggestion: aiSuggestions,
        transaction: transactions,
        account: accounts,
        connectionOwnerUserId: connections.ownerUserId,
      })
      .from(aiSuggestions)
      .innerJoin(transactions, eq(transactions.id, aiSuggestions.transactionId))
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .leftJoin(connections, eq(connections.id, accounts.connectionId))
      .where(
        and(
          eq(aiSuggestions.householdId, auth.householdId),
          eq(aiSuggestions.id, context.req.param("id")),
        ),
      )
      .get();
    if (!row) throw new NotFoundError("AI suggestion");
    const disclosureOwners = new Set(
      [row.account.ownerUserId, row.connectionOwnerUserId].filter((owner): owner is string =>
        Boolean(owner),
      ),
    );
    if (disclosureOwners.size !== 1 || !disclosureOwners.has(auth.user.id)) {
      // Do not disclose whether another household member owns the underlying transaction.
      throw new NotFoundError("AI suggestion");
    }
    const configured = configuredAiForUser(db, config, auth.householdId, auth.user.id);
    if (!configured?.enabled) throw new NotFoundError("Enabled AI integration");
    const categoryRows = await db
      .select({
        id: categories.id,
        name: categories.name,
        parentId: categories.parentId,
        kind: categories.kind,
        slug: categories.slug,
        isActive: categories.isActive,
      })
      .from(categories)
      .where(eq(categories.householdId, auth.householdId));
    const activeCategoryRows = categoryRows.filter(({ isActive }) => isActive);
    const currentPaths = categoryPathMap(categoryRows);
    const previousCategory = categoryRows.find(
      ({ id }) => id === row.suggestion.suggestedCategoryId,
    );
    const allowWebResearch = input.allowWebResearch ?? configured.webResearchEnabled;
    const regenerated = await regenerateCategory({
      apiKey: configured.apiKey,
      baseUrl: configured.baseUrl,
      model: configured.model,
      transaction: {
        normalizedDescription: row.transaction.normalizedDescription,
        direction: row.transaction.amount >= 0n ? "inflow" : "outflow",
        amountBand: coarseAmountBand(row.transaction.amount),
        currency: row.transaction.currency,
        accountType: row.account.type,
      },
      categories: categoryDisclosures(activeCategoryRows),
      userFeedback: input.feedback,
      allowWebResearch,
      previousSuggestion: {
        merchant: row.suggestion.suggestedMerchantName ?? row.transaction.normalizedDescription,
        ...(row.suggestion.suggestedCategoryId
          ? { categoryId: row.suggestion.suggestedCategoryId }
          : {}),
        ...(previousCategory
          ? {
              categoryPath: currentPaths.get(previousCategory.id) ?? previousCategory.name,
            }
          : {}),
        confidence: row.suggestion.confidenceBps / 10_000,
        rationale: row.suggestion.rationale,
        ...(row.suggestion.proposedRule
          ? {
              proposedRule: row.suggestion.proposedRule as typeof regenerated.proposedRule,
            }
          : {}),
      },
    });

    let categoryResolution: {
      categoryId: string;
      categoryName: string;
      categoryPath: string;
      createdCategoryIds: string[];
    };
    if ("proposedCategory" in regenerated && regenerated.proposedCategory) {
      categoryResolution = materializeCategoryProposal(
        db,
        auth.householdId,
        regenerated.proposedCategory,
      );
    } else {
      const categoryId = regenerated.categoryId;
      const category = activeCategoryRows.find(({ id }) => id === categoryId);
      if (!category) {
        throw new AppError(
          "The AI provider returned an unsafe categorization",
          502,
          "ai_invalid_response",
        );
      }
      categoryResolution = {
        categoryId: category.id,
        categoryName: category.name,
        categoryPath: currentPaths.get(category.id) ?? category.name,
        createdCategoryIds: [],
      };
    }
    const confidenceBps = Math.round(regenerated.confidence * 10_000);
    const auditMetadata = {
      feedbackLength: input.feedback.length,
      feedbackHash: sha256(input.feedback),
      previousCategoryId: row.suggestion.suggestedCategoryId,
      regeneratedCategoryId: categoryResolution.categoryId,
      createdCategoryIds: categoryResolution.createdCategoryIds,
      webResearchRequested: regenerated.research.requested,
      webCitationCount: regenerated.research.citationCount,
      webCitationHosts: regenerated.research.citationHosts,
      model: configured.model,
    };
    db.transaction((transaction) => {
      transaction
        .update(aiSuggestions)
        .set({
          suggestedMerchantName: regenerated.merchant,
          suggestedCategoryId: categoryResolution.categoryId,
          proposedRule: regenerated.proposedRule,
          confidenceBps,
          rationale: regenerated.rationale,
          model: configured.model,
          status: "pending",
          reviewedByUserId: null,
          reviewedAt: null,
        })
        .where(
          and(
            eq(aiSuggestions.householdId, auth.householdId),
            eq(aiSuggestions.id, row.suggestion.id),
          ),
        )
        .run();
      transaction
        .insert(auditEvents)
        .values({
          id: ulid(),
          householdId: auth.householdId,
          actorUserId: auth.user.id,
          actorType: "user",
          action: "ai.suggestion_regenerated",
          entityType: "ai_suggestion",
          entityId: row.suggestion.id,
          requestId: context.get("requestId"),
          metadata: auditMetadata,
        })
        .run();
    });
    return context.json({
      id: row.suggestion.id,
      transactionId: row.transaction.id,
      merchant: regenerated.merchant,
      categoryId: categoryResolution.categoryId,
      categoryName: categoryResolution.categoryName,
      categoryPath: categoryResolution.categoryPath.split(" / "),
      confidence: regenerated.confidence,
      rationale: regenerated.rationale,
      amount: {
        minorUnits: row.transaction.amount.toString(),
        currency: row.transaction.currency,
      },
      rawDescription: row.transaction.rawDescription,
      proposedRule: regenerated.proposedRule,
      status: "pending" as const,
      research: regenerated.research,
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
        const category = await db
          .select({ name: categories.name, kind: categories.kind })
          .from(categories)
          .where(
            and(
              eq(categories.householdId, auth.householdId),
              eq(categories.id, row.suggestion.suggestedCategoryId),
            ),
          )
          .get();
        if (!category) throw new NotFoundError("Suggested category");
        const draft = buildAiRule({
          id: ulid(),
          transaction: {
            id: row.transaction.id,
            rawDescription: row.transaction.rawDescription,
            normalizedDescription: row.transaction.normalizedDescription,
            accountId: row.transaction.accountId,
            amount: money(row.transaction.amount, row.transaction.currency),
            date: row.transaction.transactedOn.slice(0, 10),
            status: row.transaction.status === "pending" ? "pending" : "posted",
            importSource: row.transaction.source,
            ...(row.transaction.recurringSeriesId
              ? { recurringSeriesId: row.transaction.recurringSeriesId }
              : {}),
            ...(row.transaction.note ? { note: row.transaction.note } : {}),
            tagIds: [],
          },
          suggestion: {
            merchant: merchantName,
            categoryId: row.suggestion.suggestedCategoryId,
            confidence: row.suggestion.confidenceBps / 10_000,
            rationale: row.suggestion.rationale,
            ...(row.suggestion.proposedRule
              ? {
                  proposedRule: row.suggestion.proposedRule as NonNullable<
                    Parameters<typeof buildAiRule>[0]["suggestion"]["proposedRule"]
                  >,
                }
              : {}),
          },
          categoryName: category.name,
          categoryKind: category.kind,
          updatedAt: reviewedAt,
        });
        const existing = await db
          .select({ id: rules.id })
          .from(rules)
          .where(
            and(
              eq(rules.householdId, auth.householdId),
              eq(rules.name, draft.name),
              eq(rules.origin, "ai"),
            ),
          )
          .get();
        if (!existing) {
          await db.insert(rules).values({
            id: ulid(),
            householdId: auth.householdId,
            name: draft.name,
            priority: draft.priority,
            origin: "ai",
            conditions: JSON.parse(JSON.stringify(draft.condition)) as Record<string, unknown>,
            actions: JSON.parse(JSON.stringify(draft.actions)) as Record<string, unknown>,
            specificityScore: ruleSpecificity(draft.condition),
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
