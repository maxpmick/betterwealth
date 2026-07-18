import type { BetterWealthDatabase } from "@betterwealth/db";
import { assets, assetValuations } from "@betterwealth/db/schema";
import { MoneyJsonSchema } from "@betterwealth/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import { requireCsrf } from "../../auth/middleware";
import type { AppConfig } from "../../config";
import { ConflictError, NotFoundError } from "../../lib/errors";
import type { AppEnv } from "../../types";
import {
  currencySchema,
  dateSchema,
  dbJsonOrNull,
  minorUnitsSchema,
  moneyJson,
  nowIso,
  optionalMoney,
  page,
  requireAccount,
} from "./shared";

const nonNegativeMoneyJsonSchema = MoneyJsonSchema.refine(
  (value) => BigInt(value.minorUnits) >= 0n,
  "Asset values cannot be negative",
);

const assetCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    type: z.enum(["property", "vehicle", "collectible", "business", "custom"]),
    liquidityClass: z.enum(["illiquid", "restricted", "liquid"]).default("illiquid"),
    currency: currencySchema.default("USD"),
    linkedLiabilityAccountId: z.string().optional(),
    relatedLiabilityId: z.string().optional(),
    metadata: z.unknown().optional(),
    isActive: z.boolean().default(true),
    value: nonNegativeMoneyJsonSchema.optional(),
    valuedOn: dateSchema.optional(),
    valuedAt: z.string().datetime({ offset: true }).optional(),
    valuationSource: z.enum(["manual", "provider", "appraisal", "import"]).default("manual"),
    source: z.string().trim().max(160).optional(),
    confidence: z.enum(["low", "medium", "high"]).optional(),
  })
  .strict();

const assetPatchSchema = assetCreateSchema.partial();

const valuationCreateSchema = z
  .object({
    amount: nonNegativeMoneyJsonSchema.optional(),
    amountMinorUnits: minorUnitsSchema.refine((value) => BigInt(value) >= 0n).optional(),
    currency: currencySchema.optional(),
    valuedOn: dateSchema.default(() => new Date().toISOString().slice(0, 10)),
    source: z.enum(["manual", "provider", "appraisal", "import"]).default("manual"),
    confidenceBps: z.number().int().min(0).max(10_000).default(10_000),
    providerReference: z.string().trim().max(500).optional(),
    metadata: z.unknown().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.amount && input.amountMinorUnits === undefined) {
      context.addIssue({ code: "custom", path: ["amount"], message: "An asset value is required" });
    }
  });

export function createAssetRoutes(db: BetterWealthDatabase, config: AppConfig) {
  const routes = new Hono<AppEnv>();

  // Manually tracked assets and valuations -------------------------------

  routes.get("/assets", async (context) => {
    const auth = context.get("auth");
    const [assetRows, valuationRows] = await Promise.all([
      db
        .select()
        .from(assets)
        .where(and(eq(assets.householdId, auth.householdId), eq(assets.isActive, true)))
        .orderBy(asc(assets.type), asc(assets.name)),
      db
        .select()
        .from(assetValuations)
        .where(eq(assetValuations.householdId, auth.householdId))
        .orderBy(desc(assetValuations.valuedOn), desc(assetValuations.createdAt)),
    ]);
    const latest = new Map<string, (typeof valuationRows)[number]>();
    for (const valuation of valuationRows) {
      if (!latest.has(valuation.assetId)) latest.set(valuation.assetId, valuation);
    }
    return context.json(
      page(
        assetRows.map((asset) => {
          const valuation = latest.get(asset.id);
          return {
            ...asset,
            value: moneyJson(valuation?.amount ?? 0n, valuation?.currency ?? asset.currency),
            valuedAt: valuation ? `${valuation.valuedOn}T00:00:00.000Z` : asset.createdAt,
            source: valuation?.source ?? "manual",
            confidence:
              !valuation || valuation.confidenceBps >= 9_000
                ? ("high" as const)
                : valuation.confidenceBps >= 6_000
                  ? ("medium" as const)
                  : ("low" as const),
            liquidityClass: asset.liquidityClass === "liquid" ? "liquid" : "illiquid",
            ...(asset.linkedLiabilityAccountId
              ? { relatedLiabilityId: asset.linkedLiabilityAccountId }
              : {}),
            ...(valuation
              ? {
                  latestValuation: {
                    id: valuation.id,
                    amount: moneyJson(valuation.amount, valuation.currency),
                    valuedOn: valuation.valuedOn,
                    source: valuation.source,
                    confidenceBps: valuation.confidenceBps,
                  },
                }
              : { latestValuation: null }),
          };
        }),
      ),
    );
  });

  routes.post("/assets", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = assetCreateSchema.parse(await context.req.json());
    const linkedLiabilityAccountId = input.linkedLiabilityAccountId ?? input.relatedLiabilityId;
    if (linkedLiabilityAccountId) {
      await requireAccount(db, auth.householdId, linkedLiabilityAccountId);
    }
    if (input.value && input.value.currency !== input.currency) {
      throw new ConflictError("Asset and valuation currencies must match", "currency_mismatch");
    }
    const id = ulid();
    const valuationId = input.value ? ulid() : undefined;
    db.transaction((transaction) => {
      transaction
        .insert(assets)
        .values({
          id,
          householdId: auth.householdId,
          name: input.name,
          type: input.type,
          liquidityClass: input.liquidityClass,
          currency: input.currency,
          ...(linkedLiabilityAccountId ? { linkedLiabilityAccountId } : {}),
          ownerUserId: auth.user.id,
          ...(input.metadata === undefined ? {} : { metadata: dbJsonOrNull(input.metadata) }),
          isActive: input.isActive,
        })
        .run();
      if (input.value && valuationId) {
        transaction
          .insert(assetValuations)
          .values({
            id: valuationId,
            householdId: auth.householdId,
            assetId: id,
            amount: BigInt(input.value.minorUnits),
            currency: input.currency,
            valuedOn:
              input.valuedOn ??
              input.valuedAt?.slice(0, 10) ??
              new Date().toISOString().slice(0, 10),
            source: input.valuationSource,
            confidenceBps:
              input.confidence === "low" ? 4_000 : input.confidence === "medium" ? 7_500 : 10_000,
          })
          .run();
      }
    });
    return context.json(
      {
        id,
        ...(valuationId ? { valuationId } : {}),
        name: input.name,
        type: input.type,
        liquidityClass: input.liquidityClass,
        currency: input.currency,
        value: input.value ?? moneyJson(0n, input.currency),
        valuedAt:
          input.valuedAt ??
          `${input.valuedOn ?? new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
        source: input.source ?? input.valuationSource,
        confidence: input.confidence ?? "high",
        ...(linkedLiabilityAccountId ? { relatedLiabilityId: linkedLiabilityAccountId } : {}),
      },
      201,
    );
  });

  routes.patch("/assets/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const current = await db
      .select()
      .from(assets)
      .where(and(eq(assets.householdId, auth.householdId), eq(assets.id, context.req.param("id"))))
      .get();
    if (!current) throw new NotFoundError("Asset");
    const input = assetPatchSchema.parse(await context.req.json());
    const linkedLiabilityAccountId = input.linkedLiabilityAccountId ?? input.relatedLiabilityId;
    if (linkedLiabilityAccountId) {
      const liability = await requireAccount(db, auth.householdId, linkedLiabilityAccountId);
      if (!liability.isLiability) {
        throw new ConflictError("Linked asset account must be a liability", "invalid_liability");
      }
    }
    const nextCurrency = input.currency ?? current.currency;
    if (input.value && input.value.currency !== nextCurrency) {
      throw new ConflictError("Asset and valuation currencies must match", "currency_mismatch");
    }
    if (input.currency && input.currency !== current.currency) {
      const existingValuation = await db
        .select({ id: assetValuations.id })
        .from(assetValuations)
        .where(
          and(
            eq(assetValuations.householdId, auth.householdId),
            eq(assetValuations.assetId, current.id),
          ),
        )
        .get();
      if (existingValuation) {
        throw new ConflictError(
          "An asset with valuation history cannot change currency",
          "currency_history_conflict",
        );
      }
    }
    await db
      .update(assets)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.liquidityClass === undefined ? {} : { liquidityClass: input.liquidityClass }),
        ...(input.currency === undefined ? {} : { currency: input.currency }),
        ...(linkedLiabilityAccountId === undefined ? {} : { linkedLiabilityAccountId }),
        ...(input.metadata === undefined ? {} : { metadata: dbJsonOrNull(input.metadata) }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        updatedAt: nowIso(),
      })
      .where(and(eq(assets.householdId, auth.householdId), eq(assets.id, current.id)));
    if (input.value) {
      await db.insert(assetValuations).values({
        id: ulid(),
        householdId: auth.householdId,
        assetId: current.id,
        amount: BigInt(input.value.minorUnits),
        currency: input.value.currency,
        valuedOn:
          input.valuedOn ?? input.valuedAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
        source: input.valuationSource ?? "manual",
        confidenceBps:
          input.confidence === "low" ? 4_000 : input.confidence === "medium" ? 7_500 : 10_000,
      });
    }
    const updated = await db
      .select()
      .from(assets)
      .where(and(eq(assets.householdId, auth.householdId), eq(assets.id, current.id)))
      .get();
    const latest = await db
      .select()
      .from(assetValuations)
      .where(
        and(
          eq(assetValuations.householdId, auth.householdId),
          eq(assetValuations.assetId, current.id),
        ),
      )
      .orderBy(desc(assetValuations.valuedOn), desc(assetValuations.createdAt))
      .get();
    return context.json({
      ...updated!,
      value: moneyJson(latest?.amount ?? 0n, latest?.currency ?? updated!.currency),
      valuedAt: latest ? `${latest.valuedOn}T00:00:00.000Z` : updated!.updatedAt,
      source: latest?.source ?? "manual",
      confidence:
        !latest || latest.confidenceBps >= 9_000
          ? "high"
          : latest.confidenceBps >= 6_000
            ? "medium"
            : "low",
      liquidityClass: updated!.liquidityClass === "liquid" ? "liquid" : "illiquid",
      ...(updated!.linkedLiabilityAccountId
        ? { relatedLiabilityId: updated!.linkedLiabilityAccountId }
        : {}),
    });
  });

  routes.delete("/assets/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const result = await db
      .update(assets)
      .set({ isActive: false, updatedAt: nowIso() })
      .where(and(eq(assets.householdId, auth.householdId), eq(assets.id, context.req.param("id"))))
      .returning({ id: assets.id })
      .get();
    if (!result) throw new NotFoundError("Asset");
    return context.body(null, 204);
  });

  routes.get("/assets/:id/valuations", async (context) => {
    const auth = context.get("auth");
    const asset = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.householdId, auth.householdId), eq(assets.id, context.req.param("id"))))
      .get();
    if (!asset) throw new NotFoundError("Asset");
    const rows = await db
      .select()
      .from(assetValuations)
      .where(
        and(
          eq(assetValuations.householdId, auth.householdId),
          eq(assetValuations.assetId, asset.id),
        ),
      )
      .orderBy(desc(assetValuations.valuedOn), desc(assetValuations.createdAt));
    return context.json(
      page(rows.map((row) => ({ ...row, amount: moneyJson(row.amount, row.currency) }))),
    );
  });

  routes.post("/assets/:id/valuations", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const asset = await db
      .select()
      .from(assets)
      .where(and(eq(assets.householdId, auth.householdId), eq(assets.id, context.req.param("id"))))
      .get();
    if (!asset) throw new NotFoundError("Asset");
    const input = valuationCreateSchema.parse(await context.req.json());
    const amount = optionalMoney(
      input.amount,
      input.amountMinorUnits,
      input.currency ?? asset.currency,
    );
    if (amount.currency !== asset.currency) {
      throw new ConflictError("Valuation currency must match the asset", "currency_mismatch");
    }
    const proposedId = ulid();
    const saved = await db
      .insert(assetValuations)
      .values({
        id: proposedId,
        householdId: auth.householdId,
        assetId: asset.id,
        amount: amount.minor,
        currency: amount.currency,
        valuedOn: input.valuedOn,
        source: input.source,
        confidenceBps: input.confidenceBps,
        ...(input.providerReference ? { providerReference: input.providerReference } : {}),
        ...(input.metadata === undefined ? {} : { metadata: dbJsonOrNull(input.metadata) }),
      })
      .onConflictDoUpdate({
        target: [assetValuations.assetId, assetValuations.valuedOn, assetValuations.source],
        set: {
          amount: amount.minor,
          currency: amount.currency,
          confidenceBps: input.confidenceBps,
          providerReference: input.providerReference ?? null,
          metadata: input.metadata === undefined ? null : dbJsonOrNull(input.metadata),
        },
      })
      .returning({ id: assetValuations.id })
      .get();
    if (!saved) throw new NotFoundError("Asset valuation");
    return context.json(
      {
        id: saved.id,
        assetId: asset.id,
        amount: moneyJson(amount.minor, amount.currency),
        valuedOn: input.valuedOn,
        source: input.source,
        confidenceBps: input.confidenceBps,
        ...(input.providerReference ? { providerReference: input.providerReference } : {}),
      },
      201,
    );
  });

  return routes;
}
