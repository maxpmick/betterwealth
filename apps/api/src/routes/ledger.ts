import type { BetterWealthDatabase } from "@betterwealth/db";
import {
  accounts,
  auditEvents,
  balanceSnapshots,
  categories,
  envelopes,
  merchants,
  providerInstitutions,
  refundLinks,
  tags,
  transactionSplits,
  transactions,
  transactionTags,
  transfers,
} from "@betterwealth/db/schema";
import { MinorUnitsStringSchema, UlidSchema } from "@betterwealth/shared";
import { and, desc, eq, inArray, like, lt, ne, or } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import { requireAuth, requireCsrf } from "../auth/middleware";
import type { AppConfig } from "../config";
import { AppError, ConflictError, NotFoundError } from "../lib/errors";
import { normalizeDescription } from "../sync/reconcile";
import type { AppEnv } from "../types";

type MoneyJson = { minorUnits: string; currency: string };

function money(minorUnits: bigint, currency: string): MoneyJson {
  return { minorUnits: minorUnits.toString(), currency };
}

function mapGroup(group: typeof accounts.$inferSelect.group) {
  return group === "rewards" ? ("custom" as const) : group;
}

function mapReviewState(state: typeof transactions.$inferSelect.reviewState) {
  if (state === "needs_review") return "needs_review" as const;
  if (state === "reviewed") return "approved" as const;
  return "ready" as const;
}

function mapSource(source: typeof transactions.$inferSelect.source) {
  if (source === "provider") return "simplefin" as const;
  if (source === "import") return "import" as const;
  return "manual" as const;
}

function transactionProvenance(source: typeof transactions.$inferSelect.source) {
  if (source === "provider") return "SimpleFIN provider import";
  if (source === "import") return "Reviewed file import";
  if (source === "fixture") return "Seeded example data";
  return "Manual entry";
}

function queryAmountMinorUnits(value: string): bigint | null {
  const normalized = value.trim().replace(/[$,\s]/g, "");
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const negative = normalized.startsWith("-");
  const unsigned = normalized.replace(/^[+-]/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -amount : amount;
}

async function latestBalances(db: BetterWealthDatabase, householdId: string) {
  const rows = await db
    .select()
    .from(balanceSnapshots)
    .where(eq(balanceSnapshots.householdId, householdId))
    .orderBy(
      desc(balanceSnapshots.asOf),
      desc(balanceSnapshots.createdAt),
      desc(balanceSnapshots.id),
    );
  const byAccount = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!byAccount.has(row.accountId)) byAccount.set(row.accountId, row);
  return byAccount;
}

const accountCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  group: z.enum([
    "cash",
    "credit",
    "loan",
    "investment",
    "property",
    "vehicle",
    "crypto",
    "custom",
  ]),
  type: z.string().trim().min(1).max(80).default("manual"),
  subtype: z.string().trim().max(80).optional(),
  currency: z
    .string()
    .length(3)
    .transform((value) => value.toUpperCase())
    .default("USD"),
  balanceMinorUnits: MinorUnitsStringSchema.default("0"),
  mask: z.string().max(8).optional(),
  includeInBudget: z.boolean().default(true),
});

const accountPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    mask: z.string().max(8).nullable().optional(),
    group: z
      .enum(["cash", "credit", "loan", "investment", "property", "vehicle", "crypto", "custom"])
      .optional(),
    type: z.string().trim().min(1).max(80).optional(),
    subtype: z.string().trim().max(80).nullable().optional(),
    includeInBudget: z.boolean().optional(),
    includeInNetWorth: z.boolean().optional(),
    status: z.enum(["active", "closed", "hidden", "stale"]).optional(),
    balanceMinorUnits: MinorUnitsStringSchema.optional(),
  })
  .strict();

const categoryWriteSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    parentId: z.string().nullable().optional(),
    kind: z.enum(["income", "expense", "transfer", "debt", "investment"]),
    color: z.string().max(32).nullable().optional(),
    icon: z.string().max(80).nullable().optional(),
    active: z.boolean().default(true),
    sortOrder: z.number().int().min(-10_000).max(10_000).default(0),
  })
  .strict();

function categorySlug(name: string) {
  return (
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "category"
  );
}

const transactionPatchSchema = z
  .object({
    merchant: z.string().trim().min(1).max(120).optional(),
    categoryName: z.string().trim().min(1).max(120).optional(),
    note: z.string().max(2_000).nullable().optional(),
    reviewState: z.enum(["ready", "needs_review", "approved"]).optional(),
    status: z.enum(["pending", "posted"]).optional(),
    isExcluded: z.boolean().optional(),
    isTransfer: z.boolean().optional(),
    isIncome: z.boolean().optional(),
  })
  .strict();

const transactionTagsSchema = z
  .object({
    tags: z.array(z.string().trim().min(1).max(40)).max(20),
  })
  .strict();

const transactionRemovalMetadataSchema = z.object({
  previousStatus: z.enum(["pending", "posted", "void"]),
  previousUserOverrideAt: z.string().nullable().optional(),
});

const transactionCursorSchema = z.object({
  transactedOn: z.string().min(1),
  id: z.string().min(1),
});

function encodeTransactionCursor(cursor: z.infer<typeof transactionCursorSchema>) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeTransactionCursor(value: string) {
  try {
    return transactionCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw new AppError("Invalid transaction cursor", 422, "validation_failed");
  }
}

const manualTransactionSchema = z.object({
  accountId: z.string(),
  amountMinorUnits: MinorUnitsStringSchema.refine((value) => value !== "0"),
  currency: z
    .string()
    .length(3)
    .transform((value) => value.toUpperCase()),
  effectiveDate: z.string().datetime(),
  description: z.string().trim().min(1).max(500),
  categoryId: z.string().optional(),
  note: z.string().max(2_000).optional(),
});

const splitWriteSchema = z
  .object({
    splits: z
      .array(
        z
          .object({
            amountMinorUnits: MinorUnitsStringSchema.refine((value) => value !== "0"),
            categoryId: z.string().nullable().optional(),
            envelopeId: z.string().nullable().optional(),
            memo: z.string().trim().max(500).nullable().optional(),
          })
          .strict(),
      )
      .min(2)
      .max(50),
  })
  .strict();

const transferWriteSchema = z
  .object({
    outflowTransactionId: z.string().min(1),
    inflowTransactionId: z.string().min(1),
  })
  .strict();

const refundWriteSchema = z
  .object({
    refundTransactionId: z.string().min(1),
    purchaseTransactionId: z.string().min(1),
    amountMinorUnits: MinorUnitsStringSchema.refine((value) => BigInt(value) > 0n).optional(),
  })
  .strict();

function invalidLedgerOperation(message: string) {
  return new AppError(message, 422, "invalid_ledger_operation");
}

function normalizedTagName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

async function ensureMerchant(db: BetterWealthDatabase, householdId: string, name: string) {
  const normalizedName = normalizeDescription(name);
  const existing = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(
      and(eq(merchants.householdId, householdId), eq(merchants.normalizedName, normalizedName)),
    )
    .get();
  if (existing) return existing.id;
  const id = ulid();
  await db.insert(merchants).values({ id, householdId, name, normalizedName });
  return id;
}

async function ensureCategory(db: BetterWealthDatabase, householdId: string, name: string) {
  const existing = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.householdId, householdId), eq(categories.name, name)))
    .get();
  if (!existing) throw new NotFoundError("Category");
  return existing.id;
}

export function createLedgerRoutes(db: BetterWealthDatabase, config: AppConfig) {
  const routes = new Hono<AppEnv>();
  routes.use("*", requireAuth(db, config));

  routes.get("/accounts", async (context) => {
    const auth = context.get("auth");
    const [accountRows, balances] = await Promise.all([
      db
        .select({ account: accounts, institutionName: providerInstitutions.name })
        .from(accounts)
        .leftJoin(providerInstitutions, eq(providerInstitutions.id, accounts.institutionId))
        .where(eq(accounts.householdId, auth.householdId))
        .orderBy(accounts.group, accounts.name),
      latestBalances(db, auth.householdId),
    ]);
    return context.json({
      data: accountRows.map(({ account, institutionName }) => {
        const balance = balances.get(account.id);
        return {
          id: account.id,
          name: account.name,
          mask: account.mask ?? "••••",
          group: mapGroup(account.group),
          type: account.type,
          subtype: account.subtype,
          institutionName: account.isManual ? null : institutionName,
          isManual: account.isManual,
          includeInBudget: account.includeInBudget,
          includeInNetWorth: account.includeInNetWorth,
          status: account.status,
          balance: money(balance?.currentBalance ?? 0n, balance?.currency ?? account.currency),
          availableBalance:
            balance?.availableBalance === null || balance?.availableBalance === undefined
              ? undefined
              : money(balance.availableBalance, balance.currency),
          syncStatus: account.isManual
            ? ("manual" as const)
            : account.status === "stale"
              ? ("attention" as const)
              : ("healthy" as const),
          updatedAt: balance?.asOf ?? account.updatedAt,
        };
      }),
      page: { cursor: null, hasMore: false },
    });
  });

  routes.get("/accounts/:id/balances", async (context) => {
    const auth = context.get("auth");
    const account = await db
      .select()
      .from(accounts)
      .where(
        and(eq(accounts.householdId, auth.householdId), eq(accounts.id, context.req.param("id"))),
      )
      .get();
    if (!account) throw new NotFoundError("Account");
    const snapshots = await db
      .select()
      .from(balanceSnapshots)
      .where(
        and(
          eq(balanceSnapshots.householdId, auth.householdId),
          eq(balanceSnapshots.accountId, account.id),
        ),
      )
      .orderBy(balanceSnapshots.asOf, balanceSnapshots.createdAt, balanceSnapshots.id);
    const latest = snapshots.at(-1);
    const earliest = snapshots.at(0);
    return context.json({
      account: {
        id: account.id,
        name: account.name,
        currency: account.currency,
      },
      data: snapshots.map((snapshot) => ({
        id: snapshot.id,
        asOf: snapshot.asOf,
        current: money(snapshot.currentBalance, snapshot.currency),
        ledger: money(snapshot.ledgerBalance, snapshot.currency),
        available:
          snapshot.availableBalance === null
            ? null
            : money(snapshot.availableBalance, snapshot.currency),
        source: snapshot.source,
        reconciled: snapshot.currentBalance === snapshot.ledgerBalance,
      })),
      summary: {
        current: money(latest?.currentBalance ?? 0n, latest?.currency ?? account.currency),
        change: money(
          latest && earliest ? latest.currentBalance - earliest.currentBalance : 0n,
          latest?.currency ?? account.currency,
        ),
        latestAsOf: latest?.asOf ?? null,
        reconciled: latest ? latest.currentBalance === latest.ledgerBalance : null,
      },
    });
  });

  routes.post("/accounts", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = accountCreateSchema.parse(await context.req.json());
    const id = ulid();
    const now = new Date().toISOString();
    db.transaction((transaction) => {
      transaction
        .insert(accounts)
        .values({
          id,
          householdId: auth.householdId,
          ownerUserId: auth.user.id,
          name: input.name,
          mask: input.mask,
          group: input.group,
          type: input.type,
          subtype: input.subtype,
          currency: input.currency,
          isLiability: input.group === "credit" || input.group === "loan",
          isManual: true,
          includeInBudget: input.includeInBudget,
        })
        .run();
      transaction
        .insert(balanceSnapshots)
        .values({
          id: ulid(),
          householdId: auth.householdId,
          accountId: id,
          ledgerBalance: BigInt(input.balanceMinorUnits),
          currentBalance: BigInt(input.balanceMinorUnits),
          availableBalance: BigInt(input.balanceMinorUnits),
          currency: input.currency,
          asOf: now,
          source: "manual",
        })
        .run();
    });
    return context.json({ id }, 201);
  });

  routes.patch("/accounts/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = accountPatchSchema.parse(await context.req.json());
    const existing = await db
      .select()
      .from(accounts)
      .where(
        and(eq(accounts.householdId, auth.householdId), eq(accounts.id, context.req.param("id"))),
      )
      .get();
    if (!existing) throw new NotFoundError("Account");
    if (input.balanceMinorUnits !== undefined && !existing.isManual) {
      throw new ConflictError(
        "Connected account balances are read-only and must be updated by provider sync",
        "provider_balance_read_only",
      );
    }
    const overridesProviderClassification =
      !existing.isManual &&
      (input.group !== undefined || input.type !== undefined || input.subtype !== undefined);
    const overridesProviderName = !existing.isManual && input.name !== undefined;
    const overridesProviderStatus = !existing.isManual && input.status !== undefined;
    const existingProviderMetadata =
      existing.providerMetadata &&
      typeof existing.providerMetadata === "object" &&
      !Array.isArray(existing.providerMetadata)
        ? existing.providerMetadata
        : {};
    const providerMetadata =
      overridesProviderClassification || overridesProviderName || overridesProviderStatus
        ? {
            ...existingProviderMetadata,
            ...(overridesProviderClassification ? { classificationOverride: true } : {}),
            ...(overridesProviderName
              ? {
                  nameOverride: true,
                  providerName:
                    typeof existingProviderMetadata.providerName === "string"
                      ? existingProviderMetadata.providerName
                      : existing.name,
                }
              : {}),
            ...(overridesProviderStatus
              ? { statusOverride: input.status === "hidden" || input.status === "closed" }
              : {}),
          }
        : undefined;
    await db
      .update(accounts)
      .set({
        name: input.name,
        mask: input.mask,
        group: input.group,
        type: input.type,
        subtype: input.subtype,
        includeInBudget: input.includeInBudget,
        includeInNetWorth: input.includeInNetWorth,
        status: input.status,
        isLiability:
          input.group === undefined
            ? undefined
            : input.group === "credit" || input.group === "loan",
        providerMetadata,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(accounts.householdId, auth.householdId), eq(accounts.id, existing.id)));
    if (input.balanceMinorUnits !== undefined) {
      const latest = await db
        .select({ asOf: balanceSnapshots.asOf })
        .from(balanceSnapshots)
        .where(
          and(
            eq(balanceSnapshots.householdId, auth.householdId),
            eq(balanceSnapshots.accountId, existing.id),
          ),
        )
        .orderBy(desc(balanceSnapshots.asOf))
        .limit(1)
        .get();
      const latestMillis = latest ? Date.parse(latest.asOf) : 0;
      const asOf = new Date(Math.max(Date.now(), latestMillis + 1)).toISOString();
      await db.insert(balanceSnapshots).values({
        id: ulid(),
        householdId: auth.householdId,
        accountId: existing.id,
        ledgerBalance: BigInt(input.balanceMinorUnits),
        currentBalance: BigInt(input.balanceMinorUnits),
        availableBalance: BigInt(input.balanceMinorUnits),
        currency: existing.currency,
        asOf,
        source: "manual",
      });
    }
    return context.json({ id: existing.id, updated: true });
  });

  routes.get("/categories", async (context) => {
    const auth = context.get("auth");
    const rows = await db
      .select()
      .from(categories)
      .where(and(eq(categories.householdId, auth.householdId), eq(categories.isActive, true)))
      .orderBy(categories.sortOrder, categories.name);
    return context.json({
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        parentId: row.parentId,
        kind: row.kind,
        color: row.color,
        icon: row.icon,
        active: row.isActive,
        sortOrder: row.sortOrder,
      })),
      page: { cursor: null, hasMore: false },
    });
  });

  routes.post("/categories", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = categoryWriteSchema.parse(await context.req.json());
    if (input.parentId) {
      const parent = await db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.householdId, auth.householdId), eq(categories.id, input.parentId)))
        .get();
      if (!parent) throw new NotFoundError("Parent category");
    }
    const id = ulid();
    const baseSlug = categorySlug(input.name);
    const duplicate = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, auth.householdId), eq(categories.slug, baseSlug)))
      .get();
    await db.insert(categories).values({
      id,
      householdId: auth.householdId,
      parentId: input.parentId,
      name: input.name,
      slug: duplicate ? `${baseSlug}-${id.slice(-6).toLowerCase()}` : baseSlug,
      kind: input.kind,
      color: input.color,
      icon: input.icon,
      isActive: input.active,
      sortOrder: input.sortOrder,
    });
    return context.json({ id }, 201);
  });

  routes.patch("/categories/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = categoryWriteSchema.partial().parse(await context.req.json());
    const existing = await db
      .select()
      .from(categories)
      .where(
        and(
          eq(categories.householdId, auth.householdId),
          eq(categories.id, context.req.param("id")),
        ),
      )
      .get();
    if (!existing) throw new NotFoundError("Category");
    if (input.parentId === existing.id) throw new NotFoundError("Valid parent category");
    await db
      .update(categories)
      .set({
        parentId: input.parentId,
        name: input.name,
        kind: input.kind,
        color: input.color,
        icon: input.icon,
        isActive: input.active,
        sortOrder: input.sortOrder,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(categories.householdId, auth.householdId), eq(categories.id, existing.id)));
    return context.json({ id: existing.id, updated: true });
  });

  routes.get("/transactions", async (context) => {
    const auth = context.get("auth");
    const query = context.req.query("query")?.trim();
    const accountId = UlidSchema.optional().parse(context.req.query("accountId"));
    const pageSize = z.coerce
      .number()
      .int()
      .min(1)
      .max(250)
      .default(100)
      .parse(context.req.query("limit"));
    const cursorValue = context.req.query("cursor");
    const cursor = cursorValue ? decodeTransactionCursor(cursorValue) : null;
    const conditions = [
      eq(transactions.householdId, auth.householdId),
      eq(accounts.householdId, auth.householdId),
    ];
    if (accountId) conditions.push(eq(transactions.accountId, accountId));
    if (query) {
      const amount = queryAmountMinorUnits(query);
      const queryCondition = or(
        like(transactions.rawDescription, `%${query}%`),
        like(transactions.normalizedDescription, `%${query}%`),
        like(transactions.note, `%${query}%`),
        like(accounts.name, `%${query}%`),
        like(merchants.name, `%${query}%`),
        like(categories.name, `%${query}%`),
        ...(amount === null ? [] : [eq(transactions.amount, amount)]),
      );
      if (queryCondition) conditions.push(queryCondition);
    }
    if (cursor) {
      const cursorCondition = or(
        lt(transactions.transactedOn, cursor.transactedOn),
        and(eq(transactions.transactedOn, cursor.transactedOn), lt(transactions.id, cursor.id)),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    }
    const fetchedRows = await db
      .select({
        transaction: transactions,
        accountName: accounts.name,
        merchantName: merchants.name,
        categoryName: categories.name,
        envelopeName: envelopes.name,
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .leftJoin(merchants, eq(merchants.id, transactions.merchantId))
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .leftJoin(envelopes, eq(envelopes.id, transactions.envelopeId))
      .where(and(...conditions))
      .orderBy(desc(transactions.transactedOn), desc(transactions.id))
      .limit(pageSize + 1);
    const hasMore = fetchedRows.length > pageSize;
    const rows = hasMore ? fetchedRows.slice(0, pageSize) : fetchedRows;
    const ids = rows.map(({ transaction }) => transaction.id);
    const [tagRows, splitRows, transferRows, refundRows] = ids.length
      ? await Promise.all([
          db
            .select({ transactionId: transactionTags.transactionId, name: tags.name })
            .from(transactionTags)
            .innerJoin(tags, eq(tags.id, transactionTags.tagId))
            .where(
              and(
                eq(transactionTags.householdId, auth.householdId),
                inArray(transactionTags.transactionId, ids),
              ),
            ),
          db
            .select({ transactionId: transactionSplits.transactionId })
            .from(transactionSplits)
            .where(
              and(
                eq(transactionSplits.householdId, auth.householdId),
                inArray(transactionSplits.transactionId, ids),
              ),
            ),
          db
            .select({
              id: transfers.id,
              outflowTransactionId: transfers.outflowTransactionId,
              inflowTransactionId: transfers.inflowTransactionId,
              status: transfers.status,
              matchedBy: transfers.matchedBy,
            })
            .from(transfers)
            .where(
              and(
                eq(transfers.householdId, auth.householdId),
                ne(transfers.status, "rejected"),
                or(
                  inArray(transfers.outflowTransactionId, ids),
                  inArray(transfers.inflowTransactionId, ids),
                ),
              ),
            ),
          db
            .select({
              id: refundLinks.id,
              refundTransactionId: refundLinks.refundTransactionId,
              purchaseTransactionId: refundLinks.purchaseTransactionId,
              status: refundLinks.status,
              amount: refundLinks.amount,
            })
            .from(refundLinks)
            .where(
              and(
                eq(refundLinks.householdId, auth.householdId),
                ne(refundLinks.status, "rejected"),
                or(
                  inArray(refundLinks.refundTransactionId, ids),
                  inArray(refundLinks.purchaseTransactionId, ids),
                ),
              ),
            ),
        ])
      : [[], [], [], []];
    const tagsByTransaction = new Map<string, string[]>();
    for (const tag of tagRows) {
      const values = tagsByTransaction.get(tag.transactionId) ?? [];
      values.push(tag.name);
      tagsByTransaction.set(tag.transactionId, values);
    }
    const splitTransactionIds = new Set(splitRows.map(({ transactionId }) => transactionId));
    const transferIdByTransaction = new Map<string, string>();
    const transferByTransaction = new Map<
      string,
      {
        id: string;
        status: (typeof transferRows)[number]["status"];
        matchedBy: (typeof transferRows)[number]["matchedBy"];
        outflowTransactionId: string;
        inflowTransactionId: string;
      }
    >();
    for (const transfer of transferRows) {
      transferIdByTransaction.set(transfer.outflowTransactionId, transfer.id);
      transferIdByTransaction.set(transfer.inflowTransactionId, transfer.id);
      const summary = {
        id: transfer.id,
        status: transfer.status,
        matchedBy: transfer.matchedBy,
        outflowTransactionId: transfer.outflowTransactionId,
        inflowTransactionId: transfer.inflowTransactionId,
      };
      transferByTransaction.set(transfer.outflowTransactionId, summary);
      transferByTransaction.set(transfer.inflowTransactionId, summary);
    }
    const refundLinkIdsByTransaction = new Map<string, string[]>();
    const refundLinksByTransaction = new Map<
      string,
      Array<{
        id: string;
        status: (typeof refundRows)[number]["status"];
        refundTransactionId: string;
        purchaseTransactionId: string;
        amount: bigint;
      }>
    >();
    for (const link of refundRows) {
      for (const transactionId of [link.refundTransactionId, link.purchaseTransactionId]) {
        const values = refundLinkIdsByTransaction.get(transactionId) ?? [];
        values.push(link.id);
        refundLinkIdsByTransaction.set(transactionId, values);
        const summaries = refundLinksByTransaction.get(transactionId) ?? [];
        summaries.push({
          id: link.id,
          status: link.status,
          refundTransactionId: link.refundTransactionId,
          purchaseTransactionId: link.purchaseTransactionId,
          amount: link.amount,
        });
        refundLinksByTransaction.set(transactionId, summaries);
      }
    }
    const lastRow = rows.at(-1);
    return context.json({
      data: rows.map(({ transaction, accountName, merchantName, categoryName, envelopeName }) => ({
        id: transaction.id,
        effectiveDate: transaction.postedAt ?? transaction.authorizedAt ?? transaction.transactedOn,
        description: transaction.rawDescription,
        merchant: merchantName ?? transaction.normalizedDescription,
        amount: money(transaction.amount, transaction.currency),
        accountId: transaction.accountId,
        accountName,
        categoryName: categoryName ?? "Uncategorized",
        envelopeName: envelopeName ?? null,
        status: transaction.status,
        reviewState: mapReviewState(transaction.reviewState),
        source: mapSource(transaction.source),
        note: transaction.note ?? undefined,
        isRecurring: Boolean(transaction.recurringSeriesId),
        provenance: transactionProvenance(transaction.source),
        tags: tagsByTransaction.get(transaction.id) ?? [],
        isTransfer: transaction.isTransfer,
        isExcluded: transaction.isExcluded,
        isIncome: transaction.isIncome,
        hasSplits: splitTransactionIds.has(transaction.id),
        transferId: transferIdByTransaction.get(transaction.id),
        transferMatch: transferByTransaction.get(transaction.id),
        transfer: transferByTransaction.get(transaction.id),
        refundLinkIds: refundLinkIdsByTransaction.get(transaction.id) ?? [],
        refundLinks: (refundLinksByTransaction.get(transaction.id) ?? []).map((link) => ({
          ...link,
          amount: money(link.amount, transaction.currency),
        })),
      })),
      page: {
        cursor:
          hasMore && lastRow
            ? encodeTransactionCursor({
                transactedOn: lastRow.transaction.transactedOn,
                id: lastRow.transaction.id,
              })
            : null,
        hasMore,
      },
    });
  });

  routes.get("/transactions/:id", async (context) => {
    const auth = context.get("auth");
    const id = context.req.param("id");
    const row = await db
      .select({
        transaction: transactions,
        accountName: accounts.name,
        merchantName: merchants.name,
        categoryName: categories.name,
        envelopeName: envelopes.name,
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .leftJoin(merchants, eq(merchants.id, transactions.merchantId))
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .leftJoin(envelopes, eq(envelopes.id, transactions.envelopeId))
      .where(and(eq(transactions.householdId, auth.householdId), eq(transactions.id, id)))
      .get();
    if (!row) throw new NotFoundError("Transaction");

    const [splitRows, tagRows, transfer, linkedRefunds] = await Promise.all([
      db
        .select({
          id: transactionSplits.id,
          sequence: transactionSplits.sequence,
          amount: transactionSplits.amount,
          categoryId: transactionSplits.categoryId,
          envelopeId: transactionSplits.envelopeId,
          memo: transactionSplits.memo,
          categoryName: categories.name,
          envelopeName: envelopes.name,
        })
        .from(transactionSplits)
        .leftJoin(categories, eq(categories.id, transactionSplits.categoryId))
        .leftJoin(envelopes, eq(envelopes.id, transactionSplits.envelopeId))
        .where(
          and(
            eq(transactionSplits.householdId, auth.householdId),
            eq(transactionSplits.transactionId, id),
          ),
        )
        .orderBy(transactionSplits.sequence),
      db
        .select({ name: tags.name })
        .from(transactionTags)
        .innerJoin(tags, eq(tags.id, transactionTags.tagId))
        .where(
          and(
            eq(transactionTags.householdId, auth.householdId),
            eq(transactionTags.transactionId, id),
          ),
        )
        .orderBy(tags.name),
      db
        .select()
        .from(transfers)
        .where(
          and(
            eq(transfers.householdId, auth.householdId),
            ne(transfers.status, "rejected"),
            or(eq(transfers.outflowTransactionId, id), eq(transfers.inflowTransactionId, id)),
          ),
        )
        .get(),
      db
        .select()
        .from(refundLinks)
        .where(
          and(
            eq(refundLinks.householdId, auth.householdId),
            ne(refundLinks.status, "rejected"),
            or(eq(refundLinks.refundTransactionId, id), eq(refundLinks.purchaseTransactionId, id)),
          ),
        ),
    ]);

    return context.json({
      id: row.transaction.id,
      effectiveDate:
        row.transaction.postedAt ?? row.transaction.authorizedAt ?? row.transaction.transactedOn,
      description: row.transaction.rawDescription,
      merchant: row.merchantName ?? row.transaction.normalizedDescription,
      amount: money(row.transaction.amount, row.transaction.currency),
      accountId: row.transaction.accountId,
      accountName: row.accountName,
      categoryId: row.transaction.categoryId,
      categoryName: row.categoryName ?? "Uncategorized",
      envelopeId: row.transaction.envelopeId,
      envelopeName: row.envelopeName,
      status: row.transaction.status,
      reviewState: mapReviewState(row.transaction.reviewState),
      source: mapSource(row.transaction.source),
      note: row.transaction.note,
      tags: tagRows.map(({ name }) => name),
      isRecurring: Boolean(row.transaction.recurringSeriesId),
      provenance: transactionProvenance(row.transaction.source),
      isTransfer: row.transaction.isTransfer,
      isExcluded: row.transaction.isExcluded,
      isIncome: row.transaction.isIncome,
      splits: splitRows.map((split) => ({
        ...split,
        amount: money(split.amount, row.transaction.currency),
      })),
      transfer: transfer
        ? {
            id: transfer.id,
            outflowTransactionId: transfer.outflowTransactionId,
            inflowTransactionId: transfer.inflowTransactionId,
            status: transfer.status,
            matchedBy: transfer.matchedBy,
          }
        : null,
      refundLinks: linkedRefunds.map((link) => ({
        id: link.id,
        refundTransactionId: link.refundTransactionId,
        purchaseTransactionId: link.purchaseTransactionId,
        amount: money(link.amount, row.transaction.currency),
        status: link.status,
      })),
    });
  });

  routes.put("/transactions/:id/tags", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const id = context.req.param("id");
    const input = transactionTagsSchema.parse(await context.req.json());
    const uniqueRequestedTags = new Map<string, { name: string; normalizedName: string }>();
    for (const value of input.tags) {
      const name = value.normalize("NFKC").trim().replace(/\s+/g, " ");
      const normalizedName = normalizedTagName(name);
      if (!uniqueRequestedTags.has(normalizedName)) {
        uniqueRequestedTags.set(normalizedName, { name, normalizedName });
      }
    }
    const requestedTags = [...uniqueRequestedTags.values()];
    const now = new Date().toISOString();
    const result = db.transaction((transaction) => {
      const parent = transaction
        .select({ id: transactions.id, status: transactions.status })
        .from(transactions)
        .where(and(eq(transactions.householdId, auth.householdId), eq(transactions.id, id)))
        .get();
      if (!parent) return null;
      if (parent.status === "removed") {
        throw new ConflictError(
          "Restore the transaction before changing its tags",
          "transaction_removed",
        );
      }

      const previousTags = transaction
        .select({ name: tags.name })
        .from(transactionTags)
        .innerJoin(tags, eq(tags.id, transactionTags.tagId))
        .where(
          and(
            eq(transactionTags.householdId, auth.householdId),
            eq(transactionTags.transactionId, id),
          ),
        )
        .orderBy(tags.name)
        .all()
        .map(({ name }) => name);
      const resolvedTags = requestedTags.map((requested) => {
        const existing = transaction
          .select({ id: tags.id, name: tags.name })
          .from(tags)
          .where(
            and(
              eq(tags.householdId, auth.householdId),
              eq(tags.normalizedName, requested.normalizedName),
            ),
          )
          .get();
        if (existing) return existing;
        const tag = { id: ulid(), name: requested.name };
        transaction
          .insert(tags)
          .values({
            id: tag.id,
            householdId: auth.householdId,
            name: tag.name,
            normalizedName: requested.normalizedName,
          })
          .run();
        return tag;
      });

      transaction
        .delete(transactionTags)
        .where(
          and(
            eq(transactionTags.householdId, auth.householdId),
            eq(transactionTags.transactionId, id),
          ),
        )
        .run();
      if (resolvedTags.length) {
        transaction
          .insert(transactionTags)
          .values(
            resolvedTags.map((tag) => ({
              householdId: auth.householdId,
              transactionId: id,
              tagId: tag.id,
            })),
          )
          .run();
      }
      transaction
        .update(transactions)
        .set({ updatedAt: now })
        .where(and(eq(transactions.householdId, auth.householdId), eq(transactions.id, id)))
        .run();
      transaction
        .insert(auditEvents)
        .values({
          id: ulid(),
          householdId: auth.householdId,
          actorUserId: auth.user.id,
          actorType: "user",
          action: "transaction.tags_replaced",
          entityType: "transaction",
          entityId: id,
          requestId: context.get("requestId"),
          metadata: { previousTags, tags: resolvedTags.map(({ name }) => name) },
        })
        .run();
      return resolvedTags.map(({ name }) => name);
    });
    if (!result) throw new NotFoundError("Transaction");
    return context.json({ id, tags: result });
  });

  routes.delete("/transactions/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const id = context.req.param("id");
    const now = new Date().toISOString();
    const result = db.transaction((transaction) => {
      const parent = transaction
        .select({
          id: transactions.id,
          status: transactions.status,
          userOverrideAt: transactions.userOverrideAt,
        })
        .from(transactions)
        .where(and(eq(transactions.householdId, auth.householdId), eq(transactions.id, id)))
        .get();
      if (!parent) return null;
      if (parent.status === "removed") return { previousStatus: parent.status, changed: false };
      transaction
        .update(transactions)
        .set({ status: "removed", userOverrideAt: now, updatedAt: now })
        .where(and(eq(transactions.householdId, auth.householdId), eq(transactions.id, id)))
        .run();
      transaction
        .insert(auditEvents)
        .values({
          id: ulid(),
          householdId: auth.householdId,
          actorUserId: auth.user.id,
          actorType: "user",
          action: "transaction.removed",
          entityType: "transaction",
          entityId: id,
          requestId: context.get("requestId"),
          metadata: {
            previousStatus: parent.status,
            previousUserOverrideAt: parent.userOverrideAt,
          },
        })
        .run();
      return { previousStatus: parent.status, changed: true };
    });
    if (!result) throw new NotFoundError("Transaction");
    return context.json({ id, status: "removed" as const, removed: true, changed: result.changed });
  });

  routes.post("/transactions/:id/restore", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const id = context.req.param("id");
    const now = new Date().toISOString();
    const result = db.transaction((transaction) => {
      const parent = transaction
        .select({
          id: transactions.id,
          status: transactions.status,
          postedAt: transactions.postedAt,
        })
        .from(transactions)
        .where(and(eq(transactions.householdId, auth.householdId), eq(transactions.id, id)))
        .get();
      if (!parent) return null;
      if (parent.status !== "removed") {
        throw new ConflictError("Only a removed transaction can be restored", "transaction_active");
      }
      const removalEvent = transaction
        .select({ id: auditEvents.id, metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.householdId, auth.householdId),
            eq(auditEvents.action, "transaction.removed"),
            eq(auditEvents.entityType, "transaction"),
            eq(auditEvents.entityId, id),
          ),
        )
        .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
        .get();
      const removalMetadata = transactionRemovalMetadataSchema.safeParse(removalEvent?.metadata);
      const restoredStatus = parent.postedAt
        ? ("posted" as const)
        : removalMetadata.success
          ? removalMetadata.data.previousStatus
          : ("pending" as const);
      transaction
        .update(transactions)
        .set({
          status: restoredStatus,
          userOverrideAt: removalMetadata.success
            ? (removalMetadata.data.previousUserOverrideAt ?? null)
            : null,
          updatedAt: now,
        })
        .where(and(eq(transactions.householdId, auth.householdId), eq(transactions.id, id)))
        .run();
      transaction
        .insert(auditEvents)
        .values({
          id: ulid(),
          householdId: auth.householdId,
          actorUserId: auth.user.id,
          actorType: "user",
          action: "transaction.restored",
          entityType: "transaction",
          entityId: id,
          requestId: context.get("requestId"),
          metadata: {
            restoredStatus,
            restoredUserOverrideAt: removalMetadata.success
              ? (removalMetadata.data.previousUserOverrideAt ?? null)
              : null,
            removalAuditEventId: removalEvent?.id ?? null,
          },
        })
        .run();
      return restoredStatus;
    });
    if (!result) throw new NotFoundError("Transaction");
    return context.json({ id, status: result, restored: true });
  });

  routes.put("/transactions/:id/splits", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const id = context.req.param("id");
    const input = splitWriteSchema.parse(await context.req.json());
    const parent = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.householdId, auth.householdId), eq(transactions.id, id)))
      .get();
    if (!parent) throw new NotFoundError("Transaction");

    const parsedAmounts = input.splits.map((split) => BigInt(split.amountMinorUnits));
    if (parsedAmounts.some((amount) => (parent.amount < 0n ? amount >= 0n : amount <= 0n))) {
      throw invalidLedgerOperation("Every split must have the same sign as the transaction");
    }
    if (parsedAmounts.reduce((total, amount) => total + amount, 0n) !== parent.amount) {
      throw invalidLedgerOperation("Split amounts must exactly equal the transaction amount");
    }

    const categoryIds = [
      ...new Set(input.splits.flatMap((split) => (split.categoryId ? [split.categoryId] : []))),
    ];
    const envelopeIds = [
      ...new Set(input.splits.flatMap((split) => (split.envelopeId ? [split.envelopeId] : []))),
    ];
    const [validCategories, validEnvelopes] = await Promise.all([
      categoryIds.length
        ? db
            .select({ id: categories.id })
            .from(categories)
            .where(
              and(
                eq(categories.householdId, auth.householdId),
                inArray(categories.id, categoryIds),
              ),
            )
        : [],
      envelopeIds.length
        ? db
            .select({ id: envelopes.id })
            .from(envelopes)
            .where(
              and(eq(envelopes.householdId, auth.householdId), inArray(envelopes.id, envelopeIds)),
            )
        : [],
    ]);
    if (validCategories.length !== categoryIds.length) throw new NotFoundError("Category");
    if (validEnvelopes.length !== envelopeIds.length) throw new NotFoundError("Envelope");

    const now = new Date().toISOString();
    const created = db.transaction((transaction) => {
      transaction
        .delete(transactionSplits)
        .where(
          and(
            eq(transactionSplits.householdId, auth.householdId),
            eq(transactionSplits.transactionId, id),
          ),
        )
        .run();
      const rows = transaction
        .insert(transactionSplits)
        .values(
          input.splits.map((split, sequence) => ({
            id: ulid(),
            householdId: auth.householdId,
            transactionId: id,
            sequence,
            amount: BigInt(split.amountMinorUnits),
            categoryId: split.categoryId,
            envelopeId: split.envelopeId,
            memo: split.memo,
          })),
        )
        .returning()
        .all();
      transaction
        .update(transactions)
        .set({
          categoryId: null,
          envelopeId: null,
          categoryOrigin: "user",
          reviewState: "reviewed",
          userOverrideAt: now,
          updatedAt: now,
        })
        .where(and(eq(transactions.householdId, auth.householdId), eq(transactions.id, id)))
        .run();
      return rows;
    });
    return context.json({
      data: created.map((split) => ({
        id: split.id,
        sequence: split.sequence,
        amount: money(split.amount, parent.currency),
        categoryId: split.categoryId,
        envelopeId: split.envelopeId,
        memo: split.memo,
      })),
    });
  });

  routes.delete("/transactions/:id/splits", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const id = context.req.param("id");
    const parent = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.householdId, auth.householdId), eq(transactions.id, id)))
      .get();
    if (!parent) throw new NotFoundError("Transaction");
    const deleted = db.transaction((transaction) => {
      const rows = transaction
        .delete(transactionSplits)
        .where(
          and(
            eq(transactionSplits.householdId, auth.householdId),
            eq(transactionSplits.transactionId, id),
          ),
        )
        .returning({ id: transactionSplits.id })
        .all();
      if (rows.length) {
        transaction
          .update(transactions)
          .set({
            categoryOrigin: "none",
            reviewState: "needs_review",
            userOverrideAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .where(and(eq(transactions.householdId, auth.householdId), eq(transactions.id, id)))
          .run();
      }
      return rows;
    });
    if (!deleted.length) throw new NotFoundError("Transaction split");
    return context.body(null, 204);
  });

  routes.post("/transfers", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = transferWriteSchema.parse(await context.req.json());
    if (input.outflowTransactionId === input.inflowTransactionId) {
      throw invalidLedgerOperation("A transfer requires two different transactions");
    }
    const transactionRows = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.householdId, auth.householdId),
          inArray(transactions.id, [input.outflowTransactionId, input.inflowTransactionId]),
        ),
      );
    const outflow = transactionRows.find(({ id }) => id === input.outflowTransactionId);
    const inflow = transactionRows.find(({ id }) => id === input.inflowTransactionId);
    if (!outflow || !inflow) throw new NotFoundError("Transaction");
    if (outflow.accountId === inflow.accountId) {
      throw invalidLedgerOperation("Transfer sides must belong to different accounts");
    }
    if (outflow.currency !== inflow.currency || outflow.amount >= 0n || inflow.amount <= 0n) {
      throw invalidLedgerOperation("A transfer requires a same-currency outflow and inflow");
    }
    if (outflow.amount + inflow.amount !== 0n) {
      throw invalidLedgerOperation("Transfer amounts must be exact opposites");
    }
    const [exactExisting, activeExisting] = await Promise.all([
      db
        .select()
        .from(transfers)
        .where(
          and(
            eq(transfers.householdId, auth.householdId),
            eq(transfers.outflowTransactionId, outflow.id),
            eq(transfers.inflowTransactionId, inflow.id),
          ),
        )
        .get(),
      db
        .select({ id: transfers.id })
        .from(transfers)
        .where(
          and(
            eq(transfers.householdId, auth.householdId),
            ne(transfers.status, "rejected"),
            or(
              inArray(transfers.outflowTransactionId, [outflow.id, inflow.id]),
              inArray(transfers.inflowTransactionId, [outflow.id, inflow.id]),
            ),
          ),
        )
        .get(),
    ]);
    if (exactExisting?.status === "rejected") {
      throw new ConflictError("This transfer match was permanently rejected");
    }
    if (exactExisting?.status === "confirmed") {
      throw new ConflictError("These transactions are already a confirmed transfer");
    }
    if (exactExisting?.status === "unmatched") {
      throw new ConflictError("This transfer match was previously dismissed");
    }
    if (activeExisting && activeExisting.id !== exactExisting?.id) {
      throw new ConflictError("One of these transactions is already matched");
    }

    const id = exactExisting?.id ?? ulid();
    const now = new Date().toISOString();
    db.transaction((transaction) => {
      if (exactExisting?.status === "suggested") {
        const updated = transaction
          .update(transfers)
          .set({
            confidenceBps: 10_000,
            status: "confirmed",
            confirmedByUserId: auth.user.id,
            updatedAt: now,
          })
          .where(
            and(
              eq(transfers.householdId, auth.householdId),
              eq(transfers.id, exactExisting.id),
              eq(transfers.status, "suggested"),
            ),
          )
          .returning({ id: transfers.id })
          .all();
        if (!updated.length) throw new ConflictError("Transfer match changed while confirming");
      } else {
        transaction
          .insert(transfers)
          .values({
            id,
            householdId: auth.householdId,
            outflowTransactionId: outflow.id,
            inflowTransactionId: inflow.id,
            confidenceBps: 10_000,
            status: "confirmed",
            matchedBy: "user",
            confirmedByUserId: auth.user.id,
          })
          .run();
      }
      transaction
        .update(transactions)
        .set({
          isTransfer: true,
          isExcluded: true,
          reviewState: "reviewed",
          userOverrideAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(transactions.householdId, auth.householdId),
            inArray(transactions.id, [outflow.id, inflow.id]),
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
          action: "movement.confirmed",
          entityType: "transfer",
          entityId: id,
          requestId: context.get("requestId"),
          metadata: {
            movementType: "transfer",
            outflowTransactionId: outflow.id,
            inflowTransactionId: inflow.id,
            amountMinorUnits: (-outflow.amount).toString(),
            currency: outflow.currency,
            evidence: {
              source: exactExisting?.status === "suggested" ? "suggestion" : "manual",
              matchedBy: exactExisting?.matchedBy ?? "user",
              confidenceBps: exactExisting?.confidenceBps ?? 10_000,
            },
          },
        })
        .run();
    });
    return context.json({ id, status: "confirmed" }, 201);
  });

  routes.delete("/transfers/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const transferId = context.req.param("id");
    const now = new Date().toISOString();
    db.transaction((transaction) => {
      const transfer = transaction
        .select()
        .from(transfers)
        .where(and(eq(transfers.householdId, auth.householdId), eq(transfers.id, transferId)))
        .get();
      if (!transfer) throw new NotFoundError("Transfer");
      if (transfer.status === "rejected") return;
      transaction
        .update(transfers)
        .set({ status: "rejected", updatedAt: now })
        .where(
          and(
            eq(transfers.householdId, auth.householdId),
            eq(transfers.id, transfer.id),
            ne(transfers.status, "rejected"),
          ),
        )
        .run();
      if (transfer.status === "confirmed") {
        const transactionIds = [transfer.outflowTransactionId, transfer.inflowTransactionId];
        transaction
          .update(transactions)
          .set({
            isTransfer: false,
            isExcluded: false,
            reviewState: "needs_review",
            userOverrideAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(transactions.householdId, auth.householdId),
              inArray(transactions.id, transactionIds),
            ),
          )
          .run();
      }
      transaction
        .insert(auditEvents)
        .values({
          id: ulid(),
          householdId: auth.householdId,
          actorUserId: auth.user.id,
          actorType: "user",
          action: "movement.rejected",
          entityType: "transfer",
          entityId: transfer.id,
          requestId: context.get("requestId"),
          metadata: {
            movementType: "transfer",
            previousStatus: transfer.status,
            outflowTransactionId: transfer.outflowTransactionId,
            inflowTransactionId: transfer.inflowTransactionId,
            matchedBy: transfer.matchedBy,
            confidenceBps: transfer.confidenceBps,
          },
        })
        .run();
    });
    return context.body(null, 204);
  });

  routes.post("/refund-links", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = refundWriteSchema.parse(await context.req.json());
    if (input.refundTransactionId === input.purchaseTransactionId) {
      throw invalidLedgerOperation("A refund cannot link to itself");
    }
    const transactionRows = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.householdId, auth.householdId),
          inArray(transactions.id, [input.refundTransactionId, input.purchaseTransactionId]),
        ),
      );
    const refund = transactionRows.find(({ id }) => id === input.refundTransactionId);
    const purchase = transactionRows.find(({ id }) => id === input.purchaseTransactionId);
    if (!refund || !purchase) throw new NotFoundError("Transaction");
    if (
      refund.accountId !== purchase.accountId ||
      refund.currency !== purchase.currency ||
      refund.amount <= 0n ||
      purchase.amount >= 0n
    ) {
      throw invalidLedgerOperation(
        "A refund requires a same-account, same-currency credit and purchase",
      );
    }

    const now = new Date().toISOString();
    const confirmed = db.transaction((transaction) => {
      const existingLinks = transaction
        .select()
        .from(refundLinks)
        .where(
          and(
            eq(refundLinks.householdId, auth.householdId),
            or(
              eq(refundLinks.refundTransactionId, refund.id),
              eq(refundLinks.purchaseTransactionId, purchase.id),
            ),
          ),
        )
        .all();
      const exact = existingLinks.find(
        (link) =>
          link.refundTransactionId === refund.id && link.purchaseTransactionId === purchase.id,
      );
      if (exact?.status === "rejected") {
        throw new ConflictError("This refund match was permanently rejected");
      }
      if (exact?.status === "confirmed") {
        throw new ConflictError("This refund and purchase are already linked");
      }
      const activeLinks = existingLinks.filter(({ status }) => status === "confirmed");
      const usedRefund = activeLinks
        .filter((link) => link.refundTransactionId === refund.id)
        .reduce((total, link) => total + link.amount, 0n);
      const usedPurchase = activeLinks
        .filter((link) => link.purchaseTransactionId === purchase.id)
        .reduce((total, link) => total + link.amount, 0n);
      const requested = input.amountMinorUnits
        ? BigInt(input.amountMinorUnits)
        : refund.amount - usedRefund < -purchase.amount - usedPurchase
          ? refund.amount - usedRefund
          : -purchase.amount - usedPurchase;
      if (
        requested <= 0n ||
        usedRefund + requested > refund.amount ||
        usedPurchase + requested > -purchase.amount
      ) {
        throw invalidLedgerOperation(
          "Refund amount exceeds the unlinked purchase or credit amount",
        );
      }

      const id = exact?.id ?? ulid();
      if (exact) {
        const updated = transaction
          .update(refundLinks)
          .set({
            amount: requested,
            confidenceBps: 10_000,
            status: "confirmed",
            updatedAt: now,
          })
          .where(
            and(
              eq(refundLinks.householdId, auth.householdId),
              eq(refundLinks.id, exact.id),
              eq(refundLinks.status, "suggested"),
            ),
          )
          .returning({ id: refundLinks.id })
          .all();
        if (!updated.length) throw new ConflictError("Refund match changed while confirming");
      } else {
        transaction
          .insert(refundLinks)
          .values({
            id,
            householdId: auth.householdId,
            refundTransactionId: refund.id,
            purchaseTransactionId: purchase.id,
            amount: requested,
            confidenceBps: 10_000,
            status: "confirmed",
          })
          .run();
      }
      transaction
        .update(transactions)
        .set({
          categoryId: purchase.categoryId,
          envelopeId: purchase.envelopeId,
          categoryOrigin: "user",
          isIncome: false,
          isReimbursement: true,
          reviewState: "reviewed",
          userOverrideAt: now,
          updatedAt: now,
        })
        .where(and(eq(transactions.householdId, auth.householdId), eq(transactions.id, refund.id)))
        .run();
      transaction
        .insert(auditEvents)
        .values({
          id: ulid(),
          householdId: auth.householdId,
          actorUserId: auth.user.id,
          actorType: "user",
          action: "movement.confirmed",
          entityType: "refund_link",
          entityId: id,
          requestId: context.get("requestId"),
          metadata: {
            movementType: "refund",
            refundTransactionId: refund.id,
            purchaseTransactionId: purchase.id,
            amountMinorUnits: requested.toString(),
            currency: refund.currency,
            evidence: {
              source: exact?.status === "suggested" ? "suggestion" : "manual",
              confidenceBps: exact?.confidenceBps ?? 10_000,
            },
          },
        })
        .run();
      return { id, requested };
    });
    return context.json(
      {
        id: confirmed.id,
        status: "confirmed",
        amount: money(confirmed.requested, refund.currency),
      },
      201,
    );
  });

  routes.delete("/refund-links/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const linkId = context.req.param("id");
    const now = new Date().toISOString();
    db.transaction((transaction) => {
      const link = transaction
        .select()
        .from(refundLinks)
        .where(and(eq(refundLinks.householdId, auth.householdId), eq(refundLinks.id, linkId)))
        .get();
      if (!link) throw new NotFoundError("Refund link");
      if (link.status === "rejected") return;
      transaction
        .update(refundLinks)
        .set({ status: "rejected", updatedAt: now })
        .where(
          and(
            eq(refundLinks.householdId, auth.householdId),
            eq(refundLinks.id, link.id),
            ne(refundLinks.status, "rejected"),
          ),
        )
        .run();
      if (link.status === "confirmed") {
        const remaining = transaction
          .select({ status: refundLinks.status })
          .from(refundLinks)
          .where(
            and(
              eq(refundLinks.householdId, auth.householdId),
              eq(refundLinks.refundTransactionId, link.refundTransactionId),
              eq(refundLinks.status, "confirmed"),
            ),
          )
          .all();
        const hasConfirmed = remaining.length > 0;
        transaction
          .update(transactions)
          .set({
            isIncome: false,
            isReimbursement: hasConfirmed,
            reviewState: hasConfirmed ? "reviewed" : "needs_review",
            userOverrideAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(transactions.householdId, auth.householdId),
              eq(transactions.id, link.refundTransactionId),
            ),
          )
          .run();
      }
      transaction
        .insert(auditEvents)
        .values({
          id: ulid(),
          householdId: auth.householdId,
          actorUserId: auth.user.id,
          actorType: "user",
          action: "movement.rejected",
          entityType: "refund_link",
          entityId: link.id,
          requestId: context.get("requestId"),
          metadata: {
            movementType: "refund",
            previousStatus: link.status,
            refundTransactionId: link.refundTransactionId,
            purchaseTransactionId: link.purchaseTransactionId,
            amountMinorUnits: link.amount.toString(),
            confidenceBps: link.confidenceBps,
          },
        })
        .run();
    });
    return context.body(null, 204);
  });

  routes.post("/transactions", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = manualTransactionSchema.parse(await context.req.json());
    const account = await db
      .select({ id: accounts.id, currency: accounts.currency })
      .from(accounts)
      .where(and(eq(accounts.householdId, auth.householdId), eq(accounts.id, input.accountId)))
      .get();
    if (!account) throw new NotFoundError("Account");
    if (input.currency !== account.currency) {
      throw invalidLedgerOperation("Transaction currency must match the selected account");
    }
    if (input.categoryId) {
      const category = await db
        .select({ id: categories.id })
        .from(categories)
        .where(
          and(eq(categories.householdId, auth.householdId), eq(categories.id, input.categoryId)),
        )
        .get();
      if (!category) throw new NotFoundError("Category");
    }
    const id = ulid();
    await db.insert(transactions).values({
      id,
      householdId: auth.householdId,
      accountId: input.accountId,
      amount: BigInt(input.amountMinorUnits),
      currency: input.currency,
      postedAt: input.effectiveDate,
      transactedOn: input.effectiveDate,
      rawDescription: input.description,
      normalizedDescription: normalizeDescription(input.description),
      categoryId: input.categoryId,
      categoryOrigin: input.categoryId ? "user" : "none",
      status: "posted",
      source: "manual",
      reviewState: input.categoryId ? "reviewed" : "needs_review",
      note: input.note,
      userOverrideAt: input.categoryId ? new Date().toISOString() : undefined,
    });
    return context.json({ id }, 201);
  });

  routes.patch("/transactions/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = transactionPatchSchema.parse(await context.req.json());
    const existing = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.householdId, auth.householdId),
          eq(transactions.id, context.req.param("id")),
        ),
      )
      .get();
    if (!existing) throw new NotFoundError("Transaction");
    if (existing.status === "removed") {
      throw new ConflictError("Restore the transaction before changing it", "transaction_removed");
    }
    const merchantId = input.merchant
      ? await ensureMerchant(db, auth.householdId, input.merchant)
      : undefined;
    const categoryId = input.categoryName
      ? await ensureCategory(db, auth.householdId, input.categoryName)
      : undefined;
    await db
      .update(transactions)
      .set({
        merchantId,
        categoryId,
        categoryOrigin: categoryId ? "user" : undefined,
        note: input.note,
        reviewState:
          input.reviewState === "approved"
            ? "reviewed"
            : input.reviewState === "needs_review"
              ? "needs_review"
              : input.reviewState === "ready"
                ? "none"
                : undefined,
        status: input.status,
        isExcluded: input.isExcluded,
        isTransfer: input.isTransfer,
        isIncome: input.isIncome,
        userOverrideAt: new Date().toISOString(),
      })
      .where(and(eq(transactions.householdId, auth.householdId), eq(transactions.id, existing.id)));
    const [updated, updatedTags] = await Promise.all([
      db
        .select({
          transaction: transactions,
          accountName: accounts.name,
          merchantName: merchants.name,
          categoryName: categories.name,
        })
        .from(transactions)
        .innerJoin(accounts, eq(accounts.id, transactions.accountId))
        .leftJoin(merchants, eq(merchants.id, transactions.merchantId))
        .leftJoin(categories, eq(categories.id, transactions.categoryId))
        .where(
          and(eq(transactions.householdId, auth.householdId), eq(transactions.id, existing.id)),
        )
        .get(),
      db
        .select({ name: tags.name })
        .from(transactionTags)
        .innerJoin(tags, eq(tags.id, transactionTags.tagId))
        .where(
          and(
            eq(transactionTags.householdId, auth.householdId),
            eq(transactionTags.transactionId, existing.id),
          ),
        )
        .orderBy(tags.name),
    ]);
    if (!updated) throw new NotFoundError("Transaction");
    return context.json({
      id: updated.transaction.id,
      effectiveDate:
        updated.transaction.postedAt ??
        updated.transaction.authorizedAt ??
        updated.transaction.transactedOn,
      description: updated.transaction.rawDescription,
      merchant: updated.merchantName ?? updated.transaction.normalizedDescription,
      amount: money(updated.transaction.amount, updated.transaction.currency),
      accountId: updated.transaction.accountId,
      accountName: updated.accountName,
      categoryName: updated.categoryName ?? "Uncategorized",
      status: updated.transaction.status,
      reviewState: mapReviewState(updated.transaction.reviewState),
      source: mapSource(updated.transaction.source),
      note: updated.transaction.note ?? undefined,
      tags: updatedTags.map(({ name }) => name),
    });
  });

  routes.post("/transactions/bulk", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const body = z
      .object({ ids: z.array(z.string()).min(1).max(500), patch: transactionPatchSchema })
      .parse(await context.req.json());
    const categoryId = body.patch.categoryName
      ? await ensureCategory(db, auth.householdId, body.patch.categoryName)
      : undefined;
    const batchId = ulid();
    const now = new Date().toISOString();
    const affectedIds = db.transaction((transaction) => {
      const requestedIds = [...new Set(body.ids)];
      const eligibleIds = new Set(
        transaction
          .select({ id: transactions.id })
          .from(transactions)
          .where(
            and(
              eq(transactions.householdId, auth.householdId),
              inArray(transactions.id, requestedIds),
              ne(transactions.status, "removed"),
            ),
          )
          .all()
          .map(({ id }) => id),
      );
      const ids = requestedIds.filter((id) => eligibleIds.has(id));
      if (ids.length) {
        transaction
          .update(transactions)
          .set({
            categoryId,
            categoryOrigin: categoryId ? "user" : undefined,
            note: body.patch.note,
            reviewState:
              body.patch.reviewState === "approved"
                ? "reviewed"
                : body.patch.reviewState === "needs_review"
                  ? "needs_review"
                  : body.patch.reviewState === "ready"
                    ? "none"
                    : undefined,
            status: body.patch.status,
            isExcluded: body.patch.isExcluded,
            isTransfer: body.patch.isTransfer,
            isIncome: body.patch.isIncome,
            userOverrideAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(transactions.householdId, auth.householdId),
              inArray(transactions.id, ids),
              ne(transactions.status, "removed"),
            ),
          )
          .run();
      }
      transaction
        .insert(auditEvents)
        .values({
          id: batchId,
          householdId: auth.householdId,
          actorUserId: auth.user.id,
          actorType: "user",
          action: "transaction.bulk_updated",
          entityType: "transaction_batch",
          entityId: batchId,
          requestId: context.get("requestId"),
          metadata: {
            batchId,
            transactionIds: ids,
            categoryId: categoryId ?? null,
            categoryName: body.patch.categoryName ?? null,
            patch: body.patch,
          },
        })
        .run();
      return ids;
    });
    return context.json({ affected: affectedIds.length, batchId });
  });

  return routes;
}
